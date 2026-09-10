// Shared plumbing for the /api/replies resource routes (the Replies tab on
// /analytics). Server-only.
//
// WHY JSON RESOURCE ROUTES AND NOT ROUTE INTENTS. Every other page writes through
// its route's `action` with a useFetcher, and React Router revalidates every
// loader after such a POST. /analytics' loader reads the entire contact book, so
// opening a thread — a write, since it marks it read — would re-read a thousand
// contacts per click. The panel talks to these routes with plain fetch() instead,
// which revalidates nothing; api.prospect.ts makes the same call for its polling
// GET, for the same reason.

import type { LoadContext } from "../../load-context";
import { getOptionalUser, type Viewer } from "./session.server";

export const json = <T,>(data: T, status = 200, headers?: HeadersInit) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...(headers ?? {}) } });

/**
 * The signed-in viewer, or a 401 JSON response.
 *
 * NOT requireUser(): that throws a redirect to /login, which fetch() follows
 * silently and hands the panel a 200 of login-page HTML to fail to parse. A
 * session that expired while the tab sat open should say so.
 */
export async function apiUser(request: Request, ctx: LoadContext): Promise<Viewer | Response> {
  const user = await getOptionalUser(request, ctx);
  return user ?? json({ ok: false, error: "Your session has expired. Reload the page to sign in again." }, 401);
}

/**
 * Refuse a write that did not come from this app's own pages.
 *
 * Two independent checks. The `Origin` header, when the browser sends one, must
 * be this host. And the body must be declared `application/json`: a cross-site
 * page can only send that content type after a CORS preflight this app never
 * answers, so a forged form post cannot reach the handler at all. The session
 * cookie's SameSite default is a third layer; these two do not rely on it.
 */
export function writeGuard(request: Request): Response | null {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: "Cross-origin request refused." }, 403);
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return json({ ok: false, error: "Expected a JSON body." }, 415);
  }
  return null;
}

/** A JSON object body, or null when it is not one. Bounded, since it arrives from a browser. */
export async function readJsonObject(request: Request, maxBytes = 64_000): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const raw = await request.text().catch(() => "");
  if (raw.length > maxBytes) return null;
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const tooManyRequests = (retryAfterSeconds: number) =>
  json({ ok: false, error: "Too many requests. Wait a moment and try again." }, 429, {
    "Retry-After": String(retryAfterSeconds),
  });

/**
 * Log the real cause, return a reference. D1 exception text names tables and
 * columns, and this body is rendered straight into the panel — the same bargain
 * every action in the app makes.
 */
export function serverError(tag: string, err: unknown): Response {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[${tag}] ref=${ref}`, err);
  return json({ ok: false, error: `Something went wrong. Reference: ${ref}` }, 500);
}
