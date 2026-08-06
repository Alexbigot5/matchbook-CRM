import { createRequestHandler } from "react-router";
import { createRouterContext } from "../load-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

// ---------------------------------------------------------------------------
// Security headers.
//
// Applied here rather than in entry.server.tsx so they cover every dynamic
// response — the SSR document, the resource routes (/api/auth/*, /api/hyperagent)
// and error responses alike. Static assets are served by the [assets] binding
// ahead of this handler and don't carry them, which is fine: none of these
// headers protect a stylesheet.
//
// 'unsafe-inline' is present for both scripts and styles because the app needs
// it today: React Router serializes hydration data into an inline <script>, and
// the entire CRM is built from inline style attributes via css(). Moving to a
// nonce would mean threading one through the render, which is a real change to
// the streaming SSR path rather than a header tweak. The CSP still meaningfully
// constrains where code and data can come *from* — which is what stops an
// injected tag from reaching an attacker's origin.
// ---------------------------------------------------------------------------
// static.cloudflareinsights.com is Cloudflare Web Analytics. When it is enabled
// for the zone, Cloudflare injects the beacon <script> into the HTML response
// *after* this Worker returns, so the tag appears in a document whose CSP was
// written without it and the browser blocks it. Allowing the script origin (and
// the endpoint it POSTs measurements to) is what makes the injected tag work.
// Removing these two entries is fine if Web Analytics is turned off in the
// dashboard instead — the point is that the two settings have to agree.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  // Redundant with frame-ancestors for modern browsers, kept for older ones.
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // Without this the full CRM URL (which can carry a contact id) leaks to Google
  // Fonts on every stylesheet and font fetch.
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function withSecurityHeaders(response: Response, url: URL): Response {
  // Headers on a Response can be immutable, so re-wrap rather than mutate.
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  // HSTS only over real HTTPS — sending it from http://localhost would pin the
  // dev host to HTTPS in the developer's browser and break local dev.
  if (url.protocol === "https:") {
    out.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration preflight.
//
// createAuth() throws when BETTER_AUTH_SECRET is unset (deliberately — see
// app/lib/auth.server.ts). That throw happens inside a loader, so React Router
// turns it into a sanitized 500 and root.tsx renders "An unexpected error
// occurred." with no detail, because `import.meta.env.DEV` is false in a
// deployed build. The result is that the single most likely deployment mistake
// — shipping the Worker without running `wrangler secret put` — presents as an
// anonymous error page on every route, indistinguishable from a code bug or a
// bad migration. Checking up front turns it into a message that names the
// missing binding.
//
// The names are safe to disclose: no value is echoed, the set is visible in
// .dev.vars.example and wrangler.toml, and an app that cannot construct its
// auth layer is already serving nothing. The tradeoff runs the other way —
// withholding the name costs an operator a `wrangler tail` session to learn
// something the deployment checklist already states.
// ---------------------------------------------------------------------------
const REQUIRED_BINDINGS = ["DB", "BETTER_AUTH_SECRET"] as const;

const SETUP_HINT: Record<string, string> = {
  DB: "wrangler.toml [[d1_databases]] — check the binding name and database_id",
  BETTER_AUTH_SECRET: "openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET",
};

function missingBindings(env: Env): string[] {
  const e = env as unknown as Record<string, unknown>;
  return REQUIRED_BINDINGS.filter((name) => !e[name]);
}

function misconfiguredResponse(missing: string[]): Response {
  const rows = missing
    .map((name) => `<li><code>${name}</code> — <span>${SETUP_HINT[name] ?? ""}</span></li>`)
    .join("");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Matchbook CRM — not configured</title></head>` +
      `<body style="margin:0;padding:40px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1a;background:#f7f7f5;">` +
      `<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e6e6e1;border-radius:14px;padding:28px;">` +
      `<h1 style="font-size:19px;font-weight:600;margin:0 0 8px;">Matchbook CRM isn’t configured</h1>` +
      `<p style="font-size:14px;line-height:1.55;color:#57575a;margin:0 0 18px;">` +
      `The Worker is deployed but can’t start: the binding${missing.length === 1 ? " below is" : "s below are"} missing. ` +
      `This is a deployment setting, not a data problem — the database is untouched.</p>` +
      `<ul style="font-size:13px;line-height:1.9;color:#1c1c1a;margin:0;padding-left:20px;">${rows}</ul>` +
      `<p style="font-size:12px;line-height:1.55;color:#8a8a84;margin:18px 0 0;">` +
      `Redeploy (or restart <code>wrangler dev</code>) after setting these.</p>` +
      `</div></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const missing = missingBindings(env);
    if (missing.length > 0) {
      // Also log it: this is the line an operator greps for in `wrangler tail`.
      console.error(
        `[config] refusing to serve — missing binding(s): ${missing.join(", ")}`,
      );
      return withSecurityHeaders(misconfiguredResponse(missing), url);
    }

    const response = await requestHandler(request, createRouterContext(env, request));
    return withSecurityHeaders(response, url);
  },
} satisfies ExportedHandler<Env>;
