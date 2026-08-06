import type { Route } from "./+types/api.auth.$";
import { appContext } from "../../load-context";
import { isAllowed } from "../lib/allowlist";

// ---------------------------------------------------------------------------
// better-auth's HTTP handler, mounted at its default basePath (/api/auth).
//
// A resource route (no default component), so GET runs the loader and POST runs
// the action, both delegating straight to better-auth.
//
// This exists chiefly for the GET the magic link points at:
//   /api/auth/magic-link/verify?token=...&callbackURL=/
// which consumes the token, creates the session cookie, and 302s to callbackURL.
//
// The login form does NOT post here — it posts to the /login route action, which
// calls auth.api.signInMagicLink server-side. That keeps the form working without
// JS and means no better-auth client code ships to the browser.
// ---------------------------------------------------------------------------

// Paths that must stay reachable without an allowlisted session: the magic-link
// endpoints (there is no session yet at that point) and sign-out (a de-allowlisted
// user should still be able to drop their cookie rather than be stranded with it).
const ALWAYS_ALLOWED = /\/(magic-link|sign-in|sign-out)(\/|$)/;

/**
 * Re-check the allowlist before proxying to better-auth.
 *
 * requireUser() covers every loader and action in the app, but this route hands
 * requests straight to the library's own handler, which knows about sessions and
 * not about our allowlist. Without this, a user removed from allowlist.ts who
 * still holds a live cookie could keep calling `get-session` and `update-user`.
 * The blast radius was only their own record, so this closes a gap in the
 * "enforced at every layer" claim rather than a live privilege escalation.
 */
async function guard(request: Request, context: Route.LoaderArgs["context"]) {
  const ctx = context.get(appContext);
  const auth = ctx.getAuth();

  if (!ALWAYS_ALLOWED.test(new URL(request.url).pathname)) {
    // Wrapped: a session lookup failure here should not turn every auth request
    // into a 500. The handler below does its own session handling anyway.
    try {
      const session = await auth.api.getSession({ headers: request.headers });
      const email = session?.user?.email;
      if (email && !isAllowed(email)) {
        return Response.json(
          { error: "This account is no longer authorized for Matchbook CRM." },
          { status: 403 },
        );
      }
    } catch (err) {
      console.error("[api.auth] allowlist re-check failed:", err);
    }
  }

  return auth.handler(request);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  return guard(request, context);
}

export async function action({ request, context }: Route.ActionArgs) {
  return guard(request, context);
}
