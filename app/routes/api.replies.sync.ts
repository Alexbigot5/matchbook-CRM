import type { Route } from "./+types/api.replies.sync";
import { appContext } from "../../load-context";
import { rateLimit, SMARTLEAD_REPLY_SYNC_RULE } from "../lib/ratelimit.server";
import {
  apiUser,
  json,
  readJsonObject,
  serverError,
  tooManyRequests,
  writeGuard,
} from "../lib/replies-api.server";
import { syncSmartleadReplies } from "../lib/smartlead-reply-sync.server";
import { createSmartleadClient } from "../lib/smartlead.server";
import { validateReplySync } from "../lib/validate";

export async function loader() {
  return json({ ok: false, error: "Method not allowed." }, 405);
}

// POST /api/replies/sync — body { days: 7 | 30 | 90, cursor? }.
//
// "Sync from Smartlead": backfills replied conversations from Smartlead's master
// inbox into the Replies tab. Reads Smartlead and writes D1 only — it never sends
// anything and never touches contacts. See app/lib/smartlead-reply-sync.server.ts.
export async function action({ request, context }: Route.ActionArgs) {
  const guard = writeGuard(request);
  if (guard) return guard;
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;

  const limit = await rateLimit(ctx.DB, SMARTLEAD_REPLY_SYNC_RULE, user.email);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonObject(request);
  if (!body) return json({ ok: false, error: "Expected a JSON object." }, 400);
  const input = validateReplySync(body);
  if (!input.ok) return json({ ok: false, error: input.error }, 400);

  if (!ctx.SMARTLEAD_API_KEY) {
    return json({ ok: false, error: "Smartlead isn’t configured, so there’s nothing to sync from." }, 503);
  }

  try {
    const result = await syncSmartleadReplies(ctx.DB, createSmartleadClient(ctx.SMARTLEAD_API_KEY), {
      days: input.days,
      cursor: input.cursor,
      now: Date.now(),
    });
    return result.ok ? json(result) : json(result, 502);
  } catch (err) {
    return serverError("api.replies:sync", err);
  }
}
