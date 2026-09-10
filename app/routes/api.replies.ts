import type { Route } from "./+types/api.replies";
import { appContext } from "../../load-context";
import { isReplySentiment } from "../crm/replies";
import { listReplyThreads, REPLY_LIST_LIMIT } from "../lib/crm.server";
import { apiUser, json, serverError } from "../lib/replies-api.server";

// GET /api/replies?sentiment=positive|negative — one tab of the Replies list,
// newest first. Session-gated and D1-only; see app/lib/replies-api.server.ts for
// why this is a JSON resource route rather than part of /analytics' loader.
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;

  const sentiment = new URL(request.url).searchParams.get("sentiment");
  if (!isReplySentiment(sentiment)) {
    return json({ ok: false, error: "sentiment must be positive or negative." }, 400);
  }

  try {
    // Taken BEFORE the read, and a few seconds early, so every reply this list
    // could have missed is newer than it. "Mark all read" sends it back as
    // `before`; erring early only ever leaves something unread.
    const listedAt = new Date(Date.now() - 5_000).toISOString();
    const threads = await listReplyThreads(ctx.DB, sentiment, Date.now());
    return json({ ok: true, threads, truncated: threads.length >= REPLY_LIST_LIMIT, listedAt });
  } catch (err) {
    return serverError("api.replies:list", err);
  }
}
