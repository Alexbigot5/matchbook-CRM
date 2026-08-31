// The "Sync replies" button, in one place.
//
// TWO PAGES PRESS IT. The contacts page's New replies strip and /settings both
// run exactly this, which is why it is a module rather than a case in one route:
// two copies of a paginating, watermarking, contact-matching sync would drift,
// and the way they would drift is by disagreeing about what has already been
// seen. Routes contribute the session, the rate limit and the wording of the
// banner; everything about what a sync IS lives here.
//
// SHAPE OF ONE SYNC:
//
//   1. Read the connected accounts live from Unipile. Never from D1 — see
//      migrations/0021 on why the account list is not mirrored.
//   2. For each account this app can read (email or LinkedIn; everything else is
//      shown on /settings and skipped here), pull messages newer than that
//      account's watermark.
//   3. Match each one to a contact through ../crm/unipile-map, which is where
//      every rule about whose reply it is lives.
//   4. Write the matched ones, log a touchpoint each, promote `New`/`Contacted`
//      contacts to `Replied`, and move the watermark.
//
// ONE ACCOUNT'S FAILURE IS NOT THE SYNC'S. Each account is read, written and
// stamped independently, and a Unipile error on one is collected into
// `failures` while the others finish. A LinkedIn session needing re-login is the
// single most likely thing to go wrong here, and it must not stop the mailboxes
// from being read.

import {
  getUnipileSyncState,
  listContacts,
  recordReplies,
  stampUnipileSync,
  type ReplyWrite,
} from "./crm.server";
import {
  createUnipileClient,
  type UnipileAccount,
  type UnipileClient,
  type UnipileMessage,
} from "./unipile.server";
import {
  accountHealth,
  buildContactIndex,
  channelForProvider,
  describeSync,
  emailKey,
  matchEmail,
  matchLinkedin,
  planReplies,
  toSnippet,
  type ContactIndex,
  type MatchedReply,
  type ReplyCandidate,
} from "../crm/unipile-map";
import {
  UNIPILE_ACCOUNT_MAX_PAGES,
  UNIPILE_ACCOUNT_PAGE,
  UNIPILE_FIRST_SYNC_DAYS,
  UNIPILE_MAX_CHATS,
  UNIPILE_MESSAGE_MAX_PAGES,
  UNIPILE_MESSAGE_PAGE,
} from "./validate";

/** One connected account as /settings renders it: live health plus stored sync state. */
export type AccountView = {
  id: string;
  provider: string;
  name: string;
  /** 'email' | 'linkedin' | null — null means connected but not something we read. */
  channel: string | null;
  ok: boolean;
  /** Unipile's own source status: OK | CREDENTIALS | ERROR | … */
  status: string;
  lastSyncedLabel: string | null;
  lastResult: string | null;
};

export type SyncSummary = {
  accounts: number;
  replies: number;
  unmatched: number;
  promoted: number;
  /** One human sentence per account that failed, already safe to render. */
  failures: string[];
  /** The sentence the banner shows and `last_result` stores. */
  message: string;
};

const DAY_MS = 86_400_000;

/** ISO instant `days` before now, used as the first sync's lower bound. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Every connected account, across pages.
 *
 * Soft-capped (UNIPILE_ACCOUNT_MAX_PAGES): reading part of the list syncs fewer
 * mailboxes rather than misreporting anything, which is the same soft-stop
 * bargain SMARTLEAD_SENDER_MAX_PAGES makes.
 */
export async function fetchAccounts(
  client: UnipileClient,
): Promise<{ ok: true; accounts: UnipileAccount[] } | { ok: false; error: string }> {
  const accounts: UnipileAccount[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < UNIPILE_ACCOUNT_MAX_PAGES; page++) {
    const res = await client.listAccounts(UNIPILE_ACCOUNT_PAGE, cursor);
    if (!res.ok) return { ok: false, error: res.error };
    const items = res.data?.items ?? [];
    accounts.push(...items);
    cursor = res.data?.cursor ?? undefined;
    if (!cursor || items.length === 0) break;
  }

  return { ok: true, accounts };
}

/**
 * The account list as the settings page shows it, with each row's stored sync
 * state folded in.
 *
 * The live read is the source of truth for existence and health; D1 contributes
 * only "when did we last read this one, and what happened". An account with no
 * stored row has simply never been synced, which the page renders as "Never".
 */
export async function listAccountViews(
  db: D1Database,
  client: UnipileClient,
): Promise<{ ok: true; accounts: AccountView[] } | { ok: false; error: string }> {
  const [live, state] = await Promise.all([fetchAccounts(client), getUnipileSyncState(db)]);
  if (!live.ok) return live;

  const accounts: AccountView[] = live.accounts
    .filter((a) => Boolean(a.id))
    .map((a) => {
      const id = String(a.id);
      const health = accountHealth(a.sources);
      const stored = state[id];
      return {
        id,
        provider: (a.type ?? "").toUpperCase(),
        name: a.name ?? "",
        channel: channelForProvider(a.type),
        ok: health.ok,
        status: health.status,
        lastSyncedLabel: stored?.lastSyncedLabel ?? null,
        lastResult: stored?.lastResult ?? null,
      };
    });

  return { ok: true, accounts };
}

/** What one account's read produced, before anything is written. */
type AccountRead = {
  pairs: { candidate: ReplyCandidate; match: MatchedReply | null }[];
  /**
   * True when the read stopped at a budget rather than at the end of the data.
   *
   * THE WATERMARK MUST NOT ADVANCE WHEN THIS IS SET. Unipile returns newest
   * first, so a truncated read has covered the RECENT end of the window and left
   * the older end unexamined. Advancing the watermark past what was read would
   * step over those older messages permanently — they are older than the new
   * watermark, so no future sync would ever ask for them again.
   *
   * Staying put costs a repeated read of the same window on the next press, and
   * the unique index makes that a no-op rather than a duplicate. If an account
   * is so far behind that it stays stuck, /settings offers a per-account
   * "Re-read the last N days" that clears the watermark deliberately — an
   * operator's decision to skip a backlog, never this module's.
   */
  truncated: boolean;
  /** Said out loud on the page when `truncated`. */
  note: string | null;
};

/**
 * Read one mailbox's inbox since the watermark.
 *
 * `role: "inbox"` is applied by the client and is what makes this a reply reader
 * rather than a mail reader — without it the campaign's own sent mail comes
 * back, matches the contact it was addressed to, and is logged as their reply.
 *
 * `ownAddresses` is the second half of that guard: an inbox also holds mail the
 * team sent to itself, and a teammate's address matching a contact row (they do
 * get imported as test contacts) would otherwise be a reply from us to us.
 */
async function readMailbox(
  client: UnipileClient,
  accountId: string,
  after: string,
  index: ContactIndex,
  ownAddresses: Set<string>,
): Promise<{ ok: true; read: AccountRead } | { ok: false; error: string }> {
  const pairs: AccountRead["pairs"] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < UNIPILE_MESSAGE_MAX_PAGES; page++) {
    const res = await client.listEmails({
      accountId,
      limit: UNIPILE_MESSAGE_PAGE,
      after,
      cursor,
    });
    if (!res.ok) return { ok: false, error: res.error };

    const items = res.data?.items ?? [];
    for (const mail of items) {
      const id = mail.id;
      const receivedAt = mail.date;
      if (!id || !receivedAt) continue;

      const from = emailKey(mail.from_attendee?.identifier);
      // No usable sender, or it is one of our own connected mailboxes.
      if (!from || ownAddresses.has(from)) continue;

      const candidate: ReplyCandidate = {
        channel: "email",
        accountId,
        providerMessageId: id,
        threadId: mail.thread_id ?? null,
        subject: (mail.subject ?? "").slice(0, 300) || null,
        snippet: toSnippet(mail.body_plain ?? mail.body ?? ""),
        senderName: (mail.from_attendee?.display_name ?? "").slice(0, 200),
        senderIdentifier: from,
        receivedAt,
      };
      pairs.push({ candidate, match: matchEmail(candidate, index) });
    }

    cursor = res.data?.cursor ?? undefined;
    if (!cursor || items.length === 0) break;
    if (page === UNIPILE_MESSAGE_MAX_PAGES - 1) truncated = true;
  }

  return {
    ok: true,
    read: {
      pairs,
      truncated,
      note: truncated
        ? `Read the most recent ${UNIPILE_MESSAGE_MAX_PAGES * UNIPILE_MESSAGE_PAGE} messages; older ones are still waiting, so this account will be re-read next time.`
        : null,
    },
  };
}

/**
 * Read one LinkedIn account's inbound messages since the watermark.
 *
 * THREE CALLS, NOT ONE, and the reason is that a LinkedIn message has no
 * addressable identity: it carries a `sender_attendee_id` and nothing else about
 * the person. Only the chat's attendee list turns that into a name and a profile
 * URL, and only those can be matched against a CRM row. So the shape is: pull
 * the messages, group the inbound ones by chat, then resolve each chat's
 * attendees — one extra call per conversation, which is what UNIPILE_MAX_CHATS
 * bounds.
 *
 * `is_sender` is the whole filter. A 1 means we wrote it, and logging our own
 * outreach back onto the contact as their reply is the exact bug the email side
 * avoids with `role: "inbox"`.
 */
async function readLinkedin(
  client: UnipileClient,
  accountId: string,
  after: string,
  index: ContactIndex,
): Promise<{ ok: true; read: AccountRead } | { ok: false; error: string }> {
  const inbound: UnipileMessage[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < UNIPILE_MESSAGE_MAX_PAGES; page++) {
    const res = await client.listMessages({
      accountId,
      limit: UNIPILE_MESSAGE_PAGE,
      after,
      cursor,
    });
    if (!res.ok) return { ok: false, error: res.error };

    const items = res.data?.items ?? [];
    for (const message of items) {
      // `is_sender` arrives as 0/1 rather than a boolean, so this tests for
      // falsiness explicitly rather than relying on `!message.is_sender` alone
      // reading well.
      const fromUs = message.is_sender === 1 || message.is_sender === true;
      if (fromUs) continue;
      if (!message.id || !message.chat_id || !message.timestamp) continue;
      inbound.push(message);
    }

    cursor = res.data?.cursor ?? undefined;
    if (!cursor || items.length === 0) break;
    if (page === UNIPILE_MESSAGE_MAX_PAGES - 1) truncated = true;
  }

  // Newest conversation first, so a sync that hits the chat ceiling resolves the
  // most recent conversations rather than an arbitrary slice of them.
  const byChat = new Map<string, UnipileMessage[]>();
  for (const message of inbound) {
    const list = byChat.get(message.chat_id!) ?? [];
    list.push(message);
    byChat.set(message.chat_id!, list);
  }
  // Precomputed rather than derived inside the comparator: a comparator that
  // rescans a chat's messages turns a sort into a quadratic pass over every
  // message read, on the one code path whose whole job is to stay inside a
  // Worker's budget.
  const newestByChat = new Map<string, string>();
  for (const [chatId, messages] of byChat) {
    newestByChat.set(
      chatId,
      messages.reduce((max, m) => (m.timestamp! > max ? m.timestamp! : max), ""),
    );
  }
  const chatIds = [...byChat.keys()].sort((a, b) => {
    const x = newestByChat.get(a)!;
    const y = newestByChat.get(b)!;
    return x < y ? 1 : x > y ? -1 : 0;
  });

  const resolved = chatIds.slice(0, UNIPILE_MAX_CHATS);
  const skipped = chatIds.length - resolved.length;
  if (skipped > 0) truncated = true;

  const pairs: AccountRead["pairs"] = [];

  for (const chatId of resolved) {
    const res = await client.listChatAttendees(chatId);
    // A single unreadable chat is not the account's failure: a conversation can
    // be deleted between the message read and this call. Its messages are simply
    // left unmatched, and `truncated` keeps the watermark from stepping over
    // them so a later sync can try again.
    if (!res.ok) {
      truncated = true;
      continue;
    }

    const attendees = res.data?.items ?? [];
    const others = attendees.filter((a) => !(a.is_self === 1 || a.is_self === true));

    for (const message of byChat.get(chatId)!) {
      // Prefer the attendee the message actually names. Falling back to "the
      // only other person in the chat" covers 1:1 conversations where the id
      // isn't echoed back, and is refused for group chats — with two or more
      // others there is no defensible guess about who wrote it.
      const named = others.find(
        (a) => a.id === message.sender_attendee_id || a.provider_id === message.sender_id,
      );
      const attendee = named ?? (others.length === 1 ? others[0] : undefined);
      if (!attendee) continue;

      const candidate: ReplyCandidate = {
        channel: "linkedin",
        accountId,
        providerMessageId: message.id!,
        threadId: chatId,
        subject: null,
        snippet: toSnippet(message.text ?? ""),
        senderName: (attendee.name ?? "").slice(0, 200),
        // The provider id, not the profile slug: this column is what a future
        // "open this conversation" addresses the person by, and the slug is
        // already recoverable from the contact's own linkedin field.
        senderIdentifier: (attendee.provider_id ?? "").slice(0, 320),
        receivedAt: message.timestamp!,
      };
      pairs.push({
        candidate,
        match: matchLinkedin(candidate, index, {
          name: attendee.name,
          profileUrl: attendee.profile_url,
        }),
      });
    }
  }

  return {
    ok: true,
    read: {
      pairs,
      truncated,
      note:
        skipped > 0
          ? `${skipped} more conversation${skipped === 1 ? "" : "s"} had new messages than one sync reads; press Sync again to take them.`
          : truncated
            ? "Some messages couldn’t be read this time; this account will be re-read next sync."
            : null,
    },
  };
}

/**
 * Run a full sync across every connected account.
 *
 * Contacts are re-read here rather than passed in, deliberately: a sync writes
 * statuses and touchpoints, so it must match against the book as it is at the
 * moment it runs, not as some loader saw it when the page was rendered.
 */
export async function syncReplies(
  db: D1Database,
  opts: { apiKey: string; dsn: string; actor: string },
): Promise<{ ok: true; summary: SyncSummary } | { ok: false; error: string }> {
  const client = createUnipileClient(opts.apiKey, opts.dsn);
  if (!client.configured) {
    return {
      ok: false,
      error: "Unipile isn’t configured. Set UNIPILE_API_KEY and UNIPILE_DSN, then reload.",
    };
  }

  const live = await fetchAccounts(client);
  if (!live.ok) return { ok: false, error: live.error };

  const syncable = live.accounts.filter((a) => a.id && channelForProvider(a.type));
  if (!syncable.length) {
    return {
      ok: false,
      error: "No mailbox or LinkedIn account is connected to Unipile yet. Connect one below.",
    };
  }

  const [state, contacts] = await Promise.all([
    getUnipileSyncState(db),
    listContacts(db, Date.now()),
  ]);

  const index = buildContactIndex(contacts);
  const ownerByContact = new Map(contacts.map((c) => [c.id, c.owner] as const));
  // A reply belongs to the loop the contact is being worked in. A contact in
  // both loops is attributed to Loop 1, matching planLeads' rule that Loop 1 is
  // the always-on one — the alternative is a touchpoint on the event blitz for
  // someone who has since been resumed into ordinary outbound.
  const loopByContact = new Map(
    contacts.map((c) => [c.id, c.loops.includes(1) ? 1 : (c.loops[0] ?? 1)] as const),
  );

  // Every address this workspace itself sends from, so a mail from one connected
  // mailbox to another is never anybody's reply.
  const ownAddresses = new Set(
    live.accounts.map((a) => emailKey(a.name)).filter((a): a is string => Boolean(a)),
  );

  let replies = 0;
  let unmatched = 0;
  let promoted = 0;
  const failures: string[] = [];

  for (const account of syncable) {
    const id = String(account.id);
    const channel = channelForProvider(account.type);
    const provider = (account.type ?? "").toUpperCase();
    const displayName = account.name ?? "";
    const after = state[id]?.lastSyncedAt ?? isoDaysAgo(UNIPILE_FIRST_SYNC_DAYS);

    const read =
      channel === "email"
        ? await readMailbox(client, id, after, index, ownAddresses)
        : await readLinkedin(client, id, after, index);

    if (!read.ok) {
      // Named, so "one of them failed" is actionable. The account name is the
      // operator's own mailbox address, not third-party data.
      failures.push(`${displayName || provider}: ${read.error}`);
      await stampUnipileSync(db, id, {
        provider,
        displayName,
        // No advance on a failure — nothing was read, so nothing is covered.
        watermark: null,
        result: read.error,
      });
      continue;
    }

    const plan = planReplies(read.read.pairs);
    const writes: ReplyWrite[] = plan.matched.map((m) => ({
      contactId: m.contactId,
      channel: m.channel,
      accountId: m.accountId,
      providerMessageId: m.providerMessageId,
      threadId: m.threadId,
      subject: m.subject,
      snippet: m.snippet,
      senderName: m.senderName,
      senderIdentifier: m.senderIdentifier,
      matchedOn: m.matchedOn,
      receivedAt: m.receivedAt,
    }));

    const written = await recordReplies(db, writes, opts.actor, ownerByContact, loopByContact);
    replies += written.stored;
    unmatched += plan.unmatched;
    promoted += written.promoted;

    const sentence = [
      written.stored === 1 ? "1 new reply" : `${written.stored} new replies`,
      plan.unmatched > 0 ? `${plan.unmatched} unmatched` : "",
      read.read.note ?? "",
    ]
      .filter(Boolean)
      .join(". ");

    await stampUnipileSync(db, id, {
      provider,
      displayName,
      // See AccountRead.truncated: a partial read must not move the watermark
      // past the messages it never looked at.
      watermark: read.read.truncated ? null : plan.newest,
      result: sentence,
    });
  }

  return {
    ok: true,
    summary: {
      accounts: syncable.length,
      replies,
      unmatched,
      promoted,
      failures,
      message: describeSync({
        accounts: syncable.length,
        replies,
        unmatched,
        promoted,
        failed: failures.length,
      }),
    },
  };
}
