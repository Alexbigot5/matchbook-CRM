import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("lifecycle", "routes/lifecycle.tsx"),
  route("analytics", "routes/analytics.tsx"),
  route("templates", "routes/templates.tsx"),
  route("smartlead", "routes/smartlead.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  // better-auth's own HTTP handler (magic-link verify, get-session, sign-out).
  route("api/auth/*", "routes/api.auth.$.ts"),
  // Machine-callable JSON API for the HyperAgent integration (resource route).
  // Authed by a bearer token, not the session cookie — deliberately not gated.
  route("api/hyperagent", "routes/api.hyperagent.ts"),
  // The prospecting agent's resource route. SESSION-gated, unlike the one above:
  // it spends Origami credits and writes contacts, which is not a thing to hang
  // off a shared bearer token. See its module header for why its GET mutates.
  route("api/prospect", "routes/api.prospect.ts"),
] satisfies RouteConfig;
