import type { Route } from "./+types/api.replies.mark-all-read";
import { appContext } from "../../load-context";
import { isReplySentiment } from "../crm/replies";
import { markReplyThreadsRead } from "../lib/crm.server";
import { rateLimit, REPLIES_RULE } from "../lib/ratelimit.server";
import {
  apiUser,
  json,
  readJsonObject,
  serverError,
  tooManyRequests,
  writeGuard,
} from "../lib/replies-api.server";

export async function loader() {
  return json({ ok: false, error: "Method not allowed." }, 405);
}

// POST /api/replies/mark-all-read — body { sentiment, before? }.
//
// Scoped to the tab on screen, and to `before` (the `listedAt` of the list the
// rep was looking at) so a reply that reached the CRM after they last looked
// stays unread. See markReplyThreadsRead().
export async function action({ request, context }: Route.ActionArgs) {
  const guard = writeGuard(request);
  if (guard) return guard;
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;

  const limit = await rateLimit(ctx.DB, REPLIES_RULE, user.email);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readJsonObject(request);
  if (!body) return json({ ok: false, error: "Expected a JSON object." }, 400);
  if (!isReplySentiment(body.sentiment)) {
    return json({ ok: false, error: "sentiment must be positive or negative." }, 400);
  }
  let before: string | null = null;
  if (body.before !== undefined && body.before !== null) {
    const ms = typeof body.before === "string" ? Date.parse(body.before) : NaN;
    if (!Number.isFinite(ms)) return json({ ok: false, error: "before must be an ISO timestamp." }, 400);
    before = new Date(ms).toISOString();
  }

  try {
    const changed = await markReplyThreadsRead(ctx.DB, body.sentiment, before);
    return json({ ok: true, changed });
  } catch (err) {
    return serverError("api.replies:mark-all-read", err);
  }
}
