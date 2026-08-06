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
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
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

export default {
  async fetch(request, env, ctx) {
    const response = await requestHandler(request, createRouterContext(env, request));
    return withSecurityHeaders(response, new URL(request.url));
  },
} satisfies ExportedHandler<Env>;
