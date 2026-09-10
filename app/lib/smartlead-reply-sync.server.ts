// "Sync from Smartlead" — the Replies tab's backfill, in one place.
//
// The webhook (routes/api.smartlead.webhook.ts) is how replies ARRIVE; this is
// how the inbox catches up on what arrived before the webhook was registered, or
// while it was down. It never replaces the webhook and shares its writer:
// every conversation read here becomes the same plan a webhook delivery does and
// goes through recordWebhookEvent(), so a reply seen by both is stored once, and
// a sync pressed twice is a no-op.
//
// SHAPE OF ONE PRESS:
//
//   1. Read the account's lead categories once (sentiment by id and by name).
//   2. Page through POST /master-inbox/inbox-replies — replied conversations in
//      the window, newest reply first, with their message history inline so a
//      page is one subrequest.
//   3. For each conversation, skip it if the CRM already holds its newest reply
//      and category (one D1 read per page decides that for all twenty).
//   4. Otherwise write it. A conversation that came without history falls back
//      to GET message-history by lead id, within its own budget.
//
// THE WINDOW IS PINNED. `until` is fixed at the first press and carried in the
// cursor, so a reply landing mid-backfill (the webhook's job) cannot shift the
// offsets "Continue" resumes from.
//
// BUDGETS, NOT "EVERYTHING". A Worker invocation has finite subrequests and D1
// queries; see REPLY_SYNC_MAX_* in validate.ts. Reaching any budget stops the
// press cleanly with a cursor, because everything already written is final.

import {
  categoryLookup,
  historyEntriesOf,
  historyMessages,
  inboxItemsOf,
  planInboxItem,
  type CategoryLookup,
} from "../crm/replies";
import { listThreadSyncState, recordWebhookEvent } from "./crm.server";
import type { SmartleadClient } from "./smartlead.server";
import {
  REPLY_SYNC_MAX_HISTORY_LOOKUPS,
  REPLY_SYNC_MAX_PAGES,
  REPLY_SYNC_MAX_WRITES,
  REPLY_SYNC_PAGE,
  type ReplySyncCursor,
} from "./validate";

export type ReplySyncClient = Pick<SmartleadClient, "listInboxReplies" | "listLeadCategories" | "getLeadMessageHistory">;

export type ReplySyncResult =
  | {
      ok: true;
      /** One sentence for the page. */
      message: string;
      /** Where "Continue" resumes, or null when the window is done. */
      cursor: ReplySyncCursor | null;
      checked: number;
      written: number;
      newReplies: number;
    }
  | { ok: false; error: string };

const DAY_MS = 86_400_000;

/** ISO to the second, or "" — the same granularity messages are deduplicated on. */
function toSecond(raw: string | null | undefined): string {
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) : "";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function syncSmartleadReplies(
  db: D1Database,
  client: ReplySyncClient,
  input: { days: number; cursor: ReplySyncCursor | null; now: number },
): Promise<ReplySyncResult> {
  const until = input.cursor?.until ?? new Date(input.now).toISOString();
  const since = input.cursor?.since ?? new Date(Date.parse(until) - input.days * DAY_MS).toISOString();
  let offset = input.cursor?.offset ?? 0;

  // Sentiment for categories named only by id. Not fatal: conversations are
  // still stored, and the ones that can't be named keep their stored category.
  const categoriesRes = await client.listLeadCategories();
  const categories: CategoryLookup | null = categoriesRes.ok
    ? categoryLookup(
        (Array.isArray(categoriesRes.data)
          ? categoriesRes.data
          : Array.isArray((categoriesRes.data as { data?: unknown })?.data)
            ? (categoriesRes.data as { data: unknown[] }).data
            : []) as { id?: unknown; name?: unknown; sentiment_type?: unknown }[],
      )
    : null;

  let checked = 0;
  let written = 0;
  let newReplies = 0;
  let upToDate = 0;
  let unusable = 0;
  let historyLookups = 0;
  let historyFailures = 0;
  let stoppedAt: number | null = null;
  let stopReason = "";
  const receivedAt = new Date(input.now).toISOString();

  pages: for (let page = 0; page < REPLY_SYNC_MAX_PAGES; page++) {
    const res = await client.listInboxReplies(
      {
        offset,
        limit: REPLY_SYNC_PAGE,
        sortBy: "REPLY_TIME_DESC",
        filters: { emailStatus: "Replied", replyTimeBetween: [since, until] },
      },
      true,
    );
    if (!res.ok) {
      // Nothing read yet: the press failed. Something read: keep it, and let
      // Continue retry from here.
      if (checked === 0) return { ok: false, error: `Couldn’t read Smartlead’s inbox. ${res.error}` };
      stoppedAt = offset;
      stopReason = `Smartlead stopped answering (${res.error})`;
      break;
    }

    const items = inboxItemsOf(res.data);
    if (!items.length) break;

    const parsed = items.map((raw) => planInboxItem(raw, categories));
    const state = await listThreadSyncState(
      db,
      parsed.filter((p) => p !== null).map((p) => ({ campaignId: p!.plan.campaignId, email: p!.plan.email })),
    );

    for (let i = 0; i < items.length; i++) {
      const item = parsed[i];
      if (!item) {
        unusable++;
        checked++;
        continue;
      }

      const stored = state.get(`${item.plan.campaignId}|${item.plan.email}`);
      const newest = toSecond(item.lastReplyAt);
      // Current = holds the newest reply AND our side of the conversation. A thread
      // a bare webhook reply created is missing the email it answered.
      const repliesCurrent = Boolean(
        stored?.lastReplyAt && stored.hasSent && newest && toSecond(stored.lastReplyAt) >= newest,
      );
      const categoryCurrent =
        item.plan.category === null ||
        (item.plan.category.name ?? "").toLowerCase() === (stored?.category ?? "").toLowerCase();
      if (repliesCurrent && categoryCurrent) {
        upToDate++;
        checked++;
        continue;
      }

      if (written >= REPLY_SYNC_MAX_WRITES) {
        stoppedAt = offset + i;
        stopReason = `reached ${REPLY_SYNC_MAX_WRITES} conversations for one press`;
        break pages;
      }

      let plan = item.plan;
      if (repliesCurrent) {
        // Only the category moved: no need to re-read or re-write the messages.
        plan = { ...plan, messages: [] };
      } else if (!item.hasHistory && item.leadId) {
        if (historyLookups >= REPLY_SYNC_MAX_HISTORY_LOOKUPS) {
          stoppedAt = offset + i;
          stopReason = `reached ${REPLY_SYNC_MAX_HISTORY_LOOKUPS} conversation lookups for one press`;
          break pages;
        }
        historyLookups++;
        const history = await client.getLeadMessageHistory(plan.campaignId, item.leadId);
        const messages = history.ok ? historyMessages(historyEntriesOf(history.data)) : [];
        if (messages.length) {
          plan = { ...plan, messages };
        } else if (!history.ok) {
          // The newest reply alone (if the item dated it) is still worth storing.
          historyFailures++;
        }
      }

      const result = await recordWebhookEvent(db, plan, receivedAt, { smartleadRead: item.smartleadRead });
      written++;
      newReplies += result.newReplies;
      checked++;
    }

    offset += items.length;
    if (items.length < REPLY_SYNC_PAGE) break;
    if (page === REPLY_SYNC_MAX_PAGES - 1) {
      stoppedAt = offset;
      stopReason = `read ${REPLY_SYNC_MAX_PAGES * REPLY_SYNC_PAGE} conversations for one press`;
    }
  }

  const cursor = stoppedAt === null ? null : { since, until, offset: stoppedAt };
  const parts = [
    checked
      ? `Checked ${plural(checked, "conversation")}: ${plural(newReplies, "new reply", "new replies")} stored` +
        (written ? ` across ${plural(written, "thread")}` : "") +
        (upToDate ? `, ${upToDate} already up to date` : "") +
        "."
      : "No replied conversations in that window.",
  ];
  if (unusable) parts.push(`${plural(unusable, "conversation")} had no campaign or address and ${unusable === 1 ? "was" : "were"} skipped.`);
  if (historyFailures) {
    parts.push(
      `${historyFailures === 1 ? "1 conversation’s" : `${historyFailures} conversations’`} history couldn’t be read; ` +
        "only the latest reply was kept, and the next sync will try again.",
    );
  }
  if (!categories) parts.push("Lead categories couldn’t be read, so some sentiments may be missing until the next sync.");
  if (cursor) parts.push(`Stopped early (${stopReason}). Press Continue for the rest.`);

  return { ok: true, message: parts.join(" "), cursor, checked, written, newReplies };
}
