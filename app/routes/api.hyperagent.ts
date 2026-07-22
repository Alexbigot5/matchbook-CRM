import type { Route } from "./+types/api.hyperagent";
import { appContext } from "../../load-context";
import { CH, STATUSES } from "../crm/data";
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
  type NewContactInput,
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

/**
 * Returns a Response to send back (401/503) when the request is not authorized,
 * or null when the caller may proceed.
 */
function authFailure(request: Request, apiKey: string): Response | null {
  if (!apiKey) {
    return json(
      { ok: false, error: "API not configured (CRM_API_KEY is unset)." },
      503,
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, apiKey)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }
  return null;
}

const TOUCH_TYPES = new Set(Object.keys(CH)); // ad | email | linkedin | call | meeting
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

// GET /api/hyperagent — list all contacts (same shape the app loader returns).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { DB, CRM_API_KEY } = context.get(appContext);
  const fail = authFailure(request, CRM_API_KEY);
  if (fail) return fail;
  const contacts = await listContacts(DB, Date.now());
  return json({ ok: true, contacts });
}

// POST /api/hyperagent — perform one write op. Body: { op, actor?, ...args }.
export async function action({ request, context }: Route.ActionArgs) {
  const { DB, CRM_API_KEY } = context.get(appContext);
  const fail = authFailure(request, CRM_API_KEY);
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
  const actor =
    typeof body?.actor === "string" && body.actor.trim()
      ? body.actor.trim()
      : "HyperAgent";
  const id = typeof body?.id === "string" ? body.id : "";

  try {
    switch (op) {
      case "createContact": {
        const name = (body?.name ?? "").toString().trim();
        if (!name) return json({ ok: false, error: "Name is required." }, 400);
        const input: NewContactInput = {
          name,
          company: body?.company ?? "",
          email: body?.email ?? null,
          phone: body?.phone ?? null,
          linkedin: body?.linkedin ?? null,
          loops: Array.isArray(body?.loops) ? body.loops : undefined,
          owner: body?.owner ?? null,
          status: body?.status ?? "New",
          source: body?.source ?? null,
        };
        await createContact(DB, input);
        return json({ ok: true });
      }
      case "importContacts": {
        const rows = body?.rows;
        if (!Array.isArray(rows) || !rows.some((r: any) => r?.name?.trim())) {
          return json({ ok: false, error: "No valid contacts to import." }, 400);
        }
        const count = await createManyContacts(DB, rows as NewContactInput[]);
        return json({ ok: true, count });
      }
      case "setStatus": {
        const status = (body?.status ?? "").toString();
        if (!id || !status) {
          return json({ ok: false, error: "Missing id or status." }, 400);
        }
        if (!STATUS_IDS.has(status)) {
          return json({ ok: false, error: `Unknown status "${status}".` }, 400);
        }
        await updateContactStatus(DB, id, status);
        return json({ ok: true });
      }
      case "addNote": {
        const text = (body?.text ?? "").toString().trim();
        if (!id || !text) {
          return json({ ok: false, error: "Missing id or note text." }, 400);
        }
        await addNote(DB, id, actor, text);
        return json({ ok: true });
      }
      case "logTouchpoint": {
        const type = (body?.type ?? "").toString();
        const note = (body?.note ?? "").toString();
        if (!id || !type) {
          return json({ ok: false, error: "Missing id or type." }, 400);
        }
        if (!TOUCH_TYPES.has(type)) {
          return json(
            { ok: false, error: `Unknown touchpoint type "${type}".` },
            400,
          );
        }
        const loop = typeof body?.loop === "number" ? body.loop : undefined;
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
        const ids = body?.ids;
        if (!Array.isArray(ids) || !ids.length) {
          return json({ ok: false, error: "No contacts provided." }, 400);
        }
        const count = await markAdsSent(DB, ids.map(String), actor);
        return json({ ok: true, count });
      }
      default:
        return json({ ok: false, error: `Unknown op "${op}".` }, 400);
    }
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Failed." },
      500,
    );
  }
}
