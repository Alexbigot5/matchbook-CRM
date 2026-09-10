import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("lifecycle", "routes/lifecycle.tsx"),
  route("deals", "routes/deals.tsx"),
  route("analytics", "routes/analytics.tsx"),
  route("templates", "routes/templates.tsx"),
  route("smartlead", "routes/smartlead.tsx"),
  route("settings", "routes/settings.tsx"),
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
  // The Replies tab on /analytics (SESSION-gated JSON; see
  // app/lib/replies-api.server.ts). Static segments rank above `:threadId`, so
  // `counts` and `mark-all-read` never resolve as a thread id.
  route("api/replies", "routes/api.replies.ts"),
  route("api/replies/counts", "routes/api.replies.counts.ts"),
  route("api/replies/mark-all-read", "routes/api.replies.mark-all-read.ts"),
  route("api/replies/sync", "routes/api.replies.sync.ts"),
  route("api/replies/:threadId", "routes/api.replies.$threadId.ts"),
  route("api/replies/:threadId/:op", "routes/api.replies.$threadId.$op.ts"),
  // Smartlead's webhook deliveries into that inbox. NOT session-gated — it is
  // authenticated by SMARTLEAD_WEBHOOK_SECRET in the URL. See the module header.
  route("api/smartlead/webhook", "routes/api.smartlead.webhook.ts"),
] satisfies RouteConfig;
