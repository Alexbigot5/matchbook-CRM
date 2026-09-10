import type { Route } from "./+types/api.replies.counts";
import { appContext } from "../../load-context";
import { countReplyThreads } from "../lib/crm.server";
import { apiUser, json, serverError } from "../lib/replies-api.server";

// GET /api/replies/counts — { positive, negative } for the tab pills, read from
// D1 on every call, plus `unread` (the Analytics tab badge) and `uncategorized`
// (replies in neither tab). See ReplyCounts in app/crm/replies.ts.
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;

  try {
    return json({ ok: true, ...(await countReplyThreads(ctx.DB)) });
  } catch (err) {
    return serverError("api.replies:counts", err);
  }
}
