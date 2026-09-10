import type { Route } from "./+types/api.smartlead.webhook";
import { appContext } from "../../load-context";
import { categorySentimentsByName, planWebhook } from "../crm/replies";
import { recordWebhookEvent } from "../lib/crm.server";
import { json } from "../lib/replies-api.server";
import { clientKey, rateLimit, SMARTLEAD_WEBHOOK_FAIL_RULE } from "../lib/ratelimit.server";
import { createSmartleadClient } from "../lib/smartlead.server";

// ---------------------------------------------------------------------------
// POST /api/smartlead/webhook — Smartlead's deliveries into the Replies inbox.
//
// THE APP'S FIRST INBOUND WEBHOOK, and the one public unauthenticated-by-session
// endpoint that writes. migrations/0026 explains why the "no webhook" rule gave
// way here; this header is about what keeps it safe.
//
// AUTHENTICATION IS THE SECRET IN THE URL. Smartlead does not sign deliveries, so
// the webhook is registered as `…/api/smartlead/webhook?token=<secret>` and the
// token is compared in constant time. No secret configured means every delivery
// is refused (503) — never "accept anyone". Failed attempts are rate-limited per
// IP; successful ones are not (see SMARTLEAD_WEBHOOK_FAIL_RULE for why). Nothing
// here logs `request.url`, because the secret is in it.
//
// STATUS CODES ARE CHOSEN FOR SMARTLEAD'S RETRIES. It retries anything that is not
// a timely 2xx. So an event this inbox does not use, or a payload missing the
// campaign or address, is answered 200 with `ignored` — retrying cannot fix it.
// A D1 failure is answered 500 precisely so it IS retried, which is safe because
// every write in recordWebhookEvent() is idempotent.
//
// WHAT IT DOES NOT DO. It never calls Smartlead to send anything, and it never
// touches contacts: a reply landing here does not write a touchpoint or move a
// status. The only outbound call is the category-list lookup below, and only for
// a payload that named a category without saying whether it is positive.
// ---------------------------------------------------------------------------

/** Largest delivery accepted. LEAD_CATEGORY_UPDATED carries the whole conversation as HTML. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/** Constant-time compare, as api.hyperagent.ts does for its bearer token. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function loader() {
  return json({ ok: false, error: "Method not allowed." }, 405);
}

export async function action({ request, context }: Route.ActionArgs) {
  const { DB, SMARTLEAD_API_KEY, SMARTLEAD_WEBHOOK_SECRET } = context.get(appContext);

  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
  if (!SMARTLEAD_WEBHOOK_SECRET) return json({ ok: false, error: "Webhook not configured." }, 503);

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token || !safeEqual(token, SMARTLEAD_WEBHOOK_SECRET)) {
    const fails = await rateLimit(DB, SMARTLEAD_WEBHOOK_FAIL_RULE, clientKey(request));
    if (!fails.allowed) {
      return json({ ok: false, error: "Too many requests." }, 429, {
        "Retry-After": String(fails.retryAfterSeconds),
      });
    }
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return json({ ok: false, error: "Payload too large." }, 413);
  }
  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_WEBHOOK_BYTES) return json({ ok: false, error: "Payload too large." }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400);
  }

  const plan = planWebhook(payload);
  if (plan.kind === "ignore") return json({ ok: true, ignored: plan.reason });

  // A category named without its sentiment_type. Resolved through the same
  // account-wide category list the stats sync reads; if that call fails the
  // category is still stored and the sentiment stays unknown (in neither tab,
  // counted as uncategorized) until the next category event — rather than
  // failing a delivery that carries a real reply.
  if (plan.category?.name && plan.category.sentiment === null && SMARTLEAD_API_KEY) {
    const res = await createSmartleadClient(SMARTLEAD_API_KEY).listLeadCategories();
    if (res.ok) {
      const data = res.data as unknown;
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? (data as { data: unknown[] }).data
          : [];
      const byName = categorySentimentsByName(rows as { name?: unknown; sentiment_type?: unknown }[]);
      plan.category.sentiment = byName.get(plan.category.name.toLowerCase()) ?? null;
    } else {
      console.error(`[webhook] category list unavailable: ${res.error}`);
    }
  }

  try {
    const result = await recordWebhookEvent(DB, plan, new Date().toISOString());
    return json({
      ok: true,
      event: plan.event,
      stored: result.storedMessages,
      newReplies: result.newReplies,
      confirmedSends: result.confirmedSends,
      ...(result.threadId ? {} : { ignored: "no reply thread for this lead" }),
    });
  } catch (err) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[webhook:${plan.event}] ref=${ref}`, err);
    return json({ ok: false, error: `Failed. Reference: ${ref}` }, 500);
  }
}
