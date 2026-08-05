import type { Route } from "./+types/api.auth.$";
import { appContext } from "../../load-context";

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

export async function loader({ request, context }: Route.LoaderArgs) {
  return context.get(appContext).getAuth().handler(request);
}

export async function action({ request, context }: Route.ActionArgs) {
  return context.get(appContext).getAuth().handler(request);
}
