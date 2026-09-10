import type { Route } from "./+types/api.replies.$threadId";
import { appContext } from "../../load-context";
import { getReplyThread } from "../lib/crm.server";
import { apiUser, json, serverError } from "../lib/replies-api.server";
import { isValidThreadId } from "../lib/validate";

// GET /api/replies/:threadId — the whole conversation: lead detail, tags, the
// matched contact (if exactly one) and every message in order.
//
// Deliberately does NOT mark the thread read. A GET must stay safe to repeat —
// the panel re-reads an open thread on a timer to pick up webhook deliveries —
// so opening is its own POST (/read), sent once, when a rep actually clicks.
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const user = await apiUser(request, ctx);
  if (user instanceof Response) return user;
  if (!isValidThreadId(params.threadId)) return json({ ok: false, error: "No such thread." }, 404);

  try {
    const thread = await getReplyThread(ctx.DB, params.threadId, Date.now());
    if (!thread) return json({ ok: false, error: "No such thread." }, 404);
    return json({ ok: true, thread });
  } catch (err) {
    return serverError("api.replies:thread", err);
  }
}
