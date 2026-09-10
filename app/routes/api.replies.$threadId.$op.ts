import type { Route } from "./+types/api.replies.$threadId.$op";
import { appContext, type LoadContext } from "../../load-context";
import { newestStatsId } from "../crm/replies";
import { toHtmlBody } from "../crm/smartlead-map";
import {
  abandonReplySend,
  completeReplySend,
  getReplySendContext,
  markReplyThreadRead,
  reserveReplySend,
  setReplyMeetingBooked,
} from "../lib/crm.server";
import { rateLimit, REPLIES_RULE, SMARTLEAD_RULE } from "../lib/ratelimit.server";
import {
  apiUser,
  json,
  readJsonObject,
  serverError,
  tooManyRequests,
  writeGuard,
} from "../lib/replies-api.server";
import { createSmartleadClient } from "../lib/smartlead.server";
import { isValidClientKey, isValidThreadId, validateReplyText } from "../lib/validate";

// ---------------------------------------------------------------------------
// POST /api/replies/:threadId/read            mark one thread read (on open)
// POST /api/replies/:threadId/send            { text, clientKey } — a REAL email
// POST /api/replies/:threadId/meeting-booked  { booked? } — set (or flip) the flag
//
// One module because the three share every guard; `:op` is whitelisted below and
// anything else is a 404.
// ---------------------------------------------------------------------------

const OPS = new Set(["read", "send", "meeting-booked"]);

export async function loader() {
  return json({ ok: false, error: "Method not allowed." }, 405);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const guard = writeGuard(request);
  if (guard) return guard;
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;

  const { threadId, op } = params;
  if (!OPS.has(op)) return json({ ok: false, error: "Not found." }, 404);
  if (!isValidThreadId(threadId)) return json({ ok: false, error: "No such thread." }, 404);

  // Send is metered against the same per-user budget as every other Smartlead
  // write, since it is one; the D1-only ops get their own looser bucket.
  const limit = await rateLimit(ctx.DB, op === "send" ? SMARTLEAD_RULE : REPLIES_RULE, user.email);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonObject(request);
  if (!body) return json({ ok: false, error: "Expected a JSON object." }, 400);

  if (op === "read") {
    try {
      const found = await markReplyThreadRead(ctx.DB, threadId);
      return found ? json({ ok: true }) : json({ ok: false, error: "No such thread." }, 404);
    } catch (err) {
      return serverError("api.replies:read", err);
    }
  }

  if (op === "meeting-booked") {
    if (body.booked !== undefined && typeof body.booked !== "boolean") {
      return json({ ok: false, error: "booked must be true or false." }, 400);
    }
    try {
      const result = await setReplyMeetingBooked(
        ctx.DB,
        threadId,
        typeof body.booked === "boolean" ? body.booked : null,
      );
      if (!result.found) return json({ ok: false, error: "No such thread." }, 404);
      return json({ ok: true, meetingBooked: result.meetingBooked, promotedContact: result.promotedContact });
    } catch (err) {
      return serverError("api.replies:meeting-booked", err);
    }
  }

  return send(ctx, user.name, threadId, body);
}

/**
 * Send a reply through Smartlead's reply-email-thread.
 *
 * THE ORDER IS THE SAFETY:
 *   1. validate, and resolve what to reply to — nothing written yet;
 *   2. RESERVE the message row under the draft's client key (the double-send
 *      guard — see reserveReplySend());
 *   3. call Smartlead, once, never retried;
 *   4. on a refusal release the row; on success show it and mark the thread read.
 *
 * Two failure cases are deliberately NOT "release and let them try again":
 * a request that never got an answer (timeout, dropped connection) may have
 * sent, so the row stays reserved and the rep is told to check Smartlead; and a
 * D1 failure AFTER Smartlead accepted is reported as sent-but-unrecorded, because
 * a generic error there invites the second email.
 */
async function send(
  { DB, SMARTLEAD_API_KEY }: LoadContext,
  userName: string,
  threadId: string,
  body: Record<string, unknown>,
): Promise<Response> {

  const text = validateReplyText(body.text);
  if (!text.ok) return json({ ok: false, error: text.error }, 400);
  // Without a key from the page there is no double-submit protection, so one is
  // required rather than generated here.
  if (!isValidClientKey(body.clientKey)) return json({ ok: false, error: "Missing send key. Reload the page." }, 400);
  const clientKey = body.clientKey;

  if (!SMARTLEAD_API_KEY) {
    return json({ ok: false, error: "Smartlead isn’t configured, so replies can’t be sent from the CRM." }, 503);
  }

  let reserved: string | null = null;
  try {
    const sendCtx = await getReplySendContext(DB, threadId);
    if (!sendCtx) return json({ ok: false, error: "No such thread." }, 404);

    const client = createSmartleadClient(SMARTLEAD_API_KEY);

    let statsId = sendCtx.statsId;
    let resolvedStatsId: string | null = null;
    if (!statsId && sendCtx.smartleadLeadId) {
      const history = await client.getLeadMessageHistory(sendCtx.campaignId, sendCtx.smartleadLeadId);
      if (!history.ok) {
        return json({ ok: false, error: `Couldn’t look up the thread in Smartlead. ${history.error}` }, 502);
      }
      statsId = newestStatsId(history.data) || null;
      resolvedStatsId = statsId;
    }
    if (!statsId) {
      return json(
        {
          ok: false,
          error:
            "Smartlead hasn’t told the CRM which email this thread is replying to, so it can’t be answered from here yet. Reply from Smartlead’s inbox instead.",
        },
        409,
      );
    }

    const reserve = await reserveReplySend(DB, threadId, { body: text.text, sentBy: userName, clientKey });
    if (!reserve.ok) {
      return json(
        reserve.reason === "sent"
          ? { ok: false, outcome: "duplicate", error: "This reply has already been sent." }
          : {
              ok: false,
              outcome: "unknown",
              error:
                "An earlier attempt to send this reply never finished, so it may already have gone out. Check the thread in Smartlead before sending it again.",
            },
        409,
      );
    }
    reserved = reserve.messageId;

    const res = await client.replyToEmailThread(sendCtx.campaignId, {
      email_stats_id: statsId,
      email_body: toHtmlBody(text.text),
      // The mailbox's own signature, as Smartlead's inbox adds by default.
      add_signature: true,
      ...(sendCtx.replyMessageId ? { reply_message_id: sendCtx.replyMessageId } : {}),
      ...(sendCtx.latestReply
        ? {
            reply_email_time: sendCtx.latestReply.sentAt,
            reply_email_body: toHtmlBody(sendCtx.latestReply.body),
          }
        : {}),
    });

    if (!res.ok) {
      // Only a 4xx is a refusal we can trust: Smartlead looked at the request and
      // said no. No answer at all (timeout, dropped connection) or a 5xx (a
      // gateway error in front of a send that may have been queued) could each
      // have sent the email — so the reservation STAYS, a retry of this draft is
      // refused as "unknown", and the thread shows the row once it is stale.
      if (res.status === undefined || res.status >= 500) {
        reserved = null;
        const why = res.status === undefined ? "didn’t answer" : `returned an error (${res.status})`;
        return json(
          {
            ok: false,
            outcome: "unknown",
            error: `Smartlead ${why}, so this reply may or may not have been sent. Check the thread in Smartlead before sending again.`,
          },
          502,
        );
      }
      await abandonReplySend(DB, reserve.messageId);
      reserved = null;
      return json({ ok: false, error: `The reply wasn’t sent. ${res.error}` }, 502);
    }

    reserved = null;
    try {
      const message = await completeReplySend(DB, threadId, reserve.messageId, resolvedStatsId, Date.now());
      return json({ ok: true, message });
    } catch (err) {
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`[api.replies:send] sent but not recorded ref=${ref}`, err);
      return json(
        {
          ok: false,
          outcome: "sent-unrecorded",
          error: `Smartlead sent the reply, but the CRM couldn’t record it (reference ${ref}). Don’t send it again — it will appear here when Smartlead confirms it.`,
        },
        500,
      );
    }
  } catch (err) {
    // Anything thrown before Smartlead was called leaves nothing sent; release
    // the reservation (if one was made) so the rep can simply try again.
    if (reserved) await abandonReplySend(DB, reserved).catch(() => {});
    return serverError("api.replies:send", err);
  }
}
