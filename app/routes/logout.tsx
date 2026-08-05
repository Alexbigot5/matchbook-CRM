import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { appContext } from "../../load-context";

// Action-only route (no default component) behind the sidebar's "Sign out" form.
//
// Posting straight to /api/auth/sign-out would work but returns JSON, leaving the
// user staring at {"success":true}. Calling it here with asResponse:true lets us
// forward the session-clearing Set-Cookie headers onto a redirect instead.

export async function action({ request, context }: Route.ActionArgs) {
  const auth = context.get(appContext).getAuth();

  const headers = new Headers({ Location: "/login" });
  try {
    const res = await auth.api.signOut({ headers: request.headers, asResponse: true });
    for (const cookie of res.headers.getSetCookie()) {
      headers.append("Set-Cookie", cookie);
    }
  } catch (err) {
    // Already signed out, or the session row is gone — either way the user is
    // heading to /login, so this isn't worth failing the request over.
    console.error("[logout] sign-out failed:", err);
  }

  return new Response(null, { status: 302, headers });
}

export function loader() {
  return redirect("/login");
}
