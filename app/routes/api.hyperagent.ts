import type { Route } from "./+types/api.hyperagent";
import { appContext } from "../../load-context";
import { OWNERS } from "../crm/data";
import {
  API_AUTH_FAIL_RULE,
  API_RULE,
  clientKey,
  rateLimit,
} from "../lib/ratelimit.server";
import {
  asString,
  isValidLoop,
  isValidStatus,
  isValidTouchType,
  validateContact,
  validateIds,
  validateImportRows,
  validateNote,
  LIMITS,
} from "../lib/validate";
import {
  addNote,
  clearFollowUp,
  createContact,
  createManyContacts,
  listContacts,
  logTouchpoint,
  markAdsSent,
  resumeToLoop1,
  snoozeFollowUp,
  updateContactStatus,
} from "../lib/crm.server";

// ---------------------------------------------------------------------------
// Machine-callable JSON API for HyperAgent (and any other trusted automation).
//
// This is a React Router *resource route* (no default component), so GET runs
// the loader and returns JSON directly, and non-GET runs the action. Because it
// lives at its own path (/api/hyperagent) rather than the index route, it does
// NOT need the `?index` query param the form-based index action requires.
//
// Auth is a shared bearer token (CRM_API_KEY) rather than the cookie-session
// better-auth flow, which is the right fit for machine-to-machine callers.
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200) =>
  Response.json(data, { status });

/** Constant-time string compare so a wrong key can't be timing-probed. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Always walk the longer buffer so length differences don't short-circuit.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

const tooManyRequests = (retryAfterSeconds: number) =>
  Response.json(
    { ok: false, error: "Too many requests." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );

/**
 * Returns a Response to send back (401/429/503) when the request may not
 * proceed, or null when it may.
 *
 * Rate limiting lives here rather than at the route edges because this endpoint
 * is guarded by a single static bearer token that is never rotated, and its GET
 * returns the entire contact book. Unmetered, that is an unlimited brute-force
 * oracle over the most sensitive data in the app. Two limits: an overall
 * per-IP ceiling, and a much tighter one on *failed* auth attempts.
 */
async function authFailure(
  db: D1Database,
  request: Request,
  apiKey: string,
): Promise<Response | null> {
  const ip = clientKey(request);

  const overall = await rateLimit(db, API_RULE, ip);
  if (!overall.allowed) return tooManyRequests(overall.retryAfterSeconds);

  if (!apiKey) {
    // Fail closed, and say as little as possible — the previous message named
    // the missing environment variable to any unauthenticated caller.
    return json({ ok: false, error: "API unavailable." }, 503);
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, apiKey)) {
    const fails = await rateLimit(db, API_AUTH_FAIL_RULE, ip);
    if (!fails.allowed) return tooManyRequests(fails.retryAfterSeconds);
    return json({ ok: false, error: "Unauthorized." }, 401);
  }
  return null;
}

/** Cap on rows returned by a single GET when the caller doesn't specify one. */
const DEFAULT_PAGE_LIMIT = 500;

// GET /api/hyperagent — list contacts (same shape the app loader returns).
// Supports ?limit= and ?offset= so a caller can page rather than pull the whole
// database in one response.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { DB, CRM_API_KEY } = context.get(appContext);
  const fail = await authFailure(DB, request, CRM_API_KEY);
  if (fail) return fail;

  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit"));
  const rawOffset = Number(url.searchParams.get("offset"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, DEFAULT_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  const contacts = await listContacts(DB, Date.now(), { limit, offset });
  return json({ ok: true, contacts, limit, offset });
}

// POST /api/hyperagent — perform one write op. Body: { op, actor?, ...args }.
/**
 * Resolve the identity that machine-written notes and touchpoints are authored
 * under.
 *
 * `actor` used to be taken from the request body verbatim, so anyone holding the
 * bearer token could author a note as "Tom" — indistinguishable in the timeline
 * from something Tom actually wrote. (The session path never had this problem;
 * it stamps `user.name` from the server session.) A caller-supplied label is
 * still useful for telling automations apart, so it's kept — but it is always
 * namespaced under "HyperAgent", and a label that collides with a real user's
 * name is dropped.
 */
function machineActor(raw: unknown): string {
  const label = asString(raw);
  if (!label || Object.hasOwn(OWNERS, label)) return "HyperAgent";
  return `HyperAgent (${label.slice(0, 40)})`;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { DB, CRM_API_KEY } = context.get(appContext);
  const fail = await authFailure(DB, request, CRM_API_KEY);
  if (fail) return fail;

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON." }, 400);
  }

  const op = typeof body?.op === "string" ? body.op : "";
  const actor = machineActor(body?.actor);
  const id = typeof body?.id === "string" ? body.id : "";

  try {
    switch (op) {
      case "createContact": {
        // Same validator the session action uses — bounds every field,
        // whitelists owner/status/loops and checks the email format. Previously
        // these were passed through untyped, so a non-string field threw a
        // TypeError deep in the insert.
        const result = validateContact(body);
        if (!result.ok) return json({ ok: false, error: result.error }, 400);
        await createContact(DB, result.value);
        return json({ ok: true });
      }
      case "importContacts": {
        const result = validateImportRows(body?.rows);
        if (!result.ok) return json({ ok: false, error: result.error }, 400);
        const count = await createManyContacts(DB, result.rows);
        return json({ ok: true, count, skipped: result.skipped });
      }
      case "setStatus": {
        const status = asString(body?.status);
        if (!id || !status) {
          return json({ ok: false, error: "Missing id or status." }, 400);
        }
        if (!isValidStatus(status)) {
          return json({ ok: false, error: "Unknown status." }, 400);
        }
        await updateContactStatus(DB, id, status);
        return json({ ok: true });
      }
      case "addNote": {
        if (!id) return json({ ok: false, error: "Missing id." }, 400);
        const note = validateNote(body?.text);
        if (!note.ok) return json({ ok: false, error: note.error }, 400);
        await addNote(DB, id, actor, note.text);
        return json({ ok: true });
      }
      case "logTouchpoint": {
        const type = asString(body?.type);
        if (!id || !type) {
          return json({ ok: false, error: "Missing id or type." }, 400);
        }
        if (!isValidTouchType(type)) {
          return json({ ok: false, error: "Unknown touchpoint type." }, 400);
        }
        const note = asString(body?.note);
        if (note.length > LIMITS.note) {
          return json(
            { ok: false, error: `Notes must be ${LIMITS.note} characters or fewer.` },
            400,
          );
        }
        // Out-of-range loops are rejected rather than stored; logTouchpoint also
        // falls back to the contact's primary loop as a second line of defence.
        const rawLoop = body?.loop;
        if (rawLoop !== undefined && rawLoop !== null && !isValidLoop(rawLoop)) {
          return json({ ok: false, error: "Loop must be 1 or 2." }, 400);
        }
        const loop = isValidLoop(rawLoop) ? rawLoop : undefined;
        await logTouchpoint(DB, id, type, actor, note, loop);
        return json({ ok: true });
      }
      case "snooze": {
        if (!id) return json({ ok: false, error: "Missing id." }, 400);
        await snoozeFollowUp(DB, id);
        return json({ ok: true });
      }
      case "clearFollow": {
        if (!id) return json({ ok: false, error: "Missing id." }, 400);
        await clearFollowUp(DB, id);
        return json({ ok: true });
      }
      case "resumeLoop1": {
        if (!id) return json({ ok: false, error: "Missing id." }, 400);
        await resumeToLoop1(DB, id);
        return json({ ok: true });
      }
      case "markAdsSent": {
        const ids = validateIds(body?.ids);
        if (!ids.ok) return json({ ok: false, error: ids.error }, 400);
        const count = await markAdsSent(DB, ids.ids, actor);
        return json({ ok: true, count });
      }
      default:
        return json({ ok: false, error: "Unknown op." }, 400);
    }
  } catch (err) {
    // Log the cause, return a reference. Raw D1 messages name tables, columns
    // and constraints, which is a free schema readout for anyone probing the
    // endpoint.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[api.hyperagent:${op}] ref=${ref}`, err);
    return json({ ok: false, error: `Request failed. Reference: ${ref}` }, 500);
  }
}
