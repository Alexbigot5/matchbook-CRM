import { redirect } from "react-router";
import type { LoadContext } from "../../load-context";
import { displayNameFor, isAllowed, normalizeEmail } from "./allowlist";

// Session helpers for route loaders/actions. Follows the crm.server.ts convention:
// plain functions that take what the caller already pulled out of context.

export type Viewer = {
  email: string;
  /** Display name from the allowlist — the author stamped on notes/touchpoints. */
  name: string;
};

/** The signed-in viewer, or null if there is no valid allowlisted session. */
export async function getOptionalUser(
  request: Request,
  ctx: LoadContext,
): Promise<Viewer | null> {
  const session = await ctx.getAuth().api.getSession({ headers: request.headers });
  const email = session?.user?.email;
  // Re-checking the allowlist here (not just at sign-in) is what makes removing
  // an address take effect immediately, even for someone holding a live cookie.
  if (!email || !isAllowed(email)) return null;
  return { email: normalizeEmail(email), name: displayNameFor(email) };
}

/**
 * Require a signed-in, allowlisted viewer. Throws a redirect to /login otherwise
 * — which works from both loaders and actions.
 *
 * Actions must call this independently of loaders: a loader-only check would
 * leave every mutation endpoint open.
 */
export async function requireUser(request: Request, ctx: LoadContext): Promise<Viewer> {
  const user = await getOptionalUser(request, ctx);
  if (!user) {
    const url = new URL(request.url);
    const next = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?next=${next}`);
  }
  return user;
}
