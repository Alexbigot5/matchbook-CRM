// The contact write path, shared by the routes that render contact UI.
//
// Actions are per-route in React Router, and the detail slide-over posts to
// whichever route rendered it — so both `/` and `/lifecycle` need the same set of
// intents. Rather than keep two switches in step by hand, both routes delegate
// here.
//
// The try/catch below is the main reason this is one module rather than two
// copies. D1 exception text carries table, column and constraint names ("no such
// column: source"), and an action's return value is rendered straight into the
// UI — so returning it hands the client a schema readout while leaving the
// operator with nothing. The reference id ties the opaque user-facing message to
// the real cause in `wrangler tail`. A hand-copied second action is exactly where
// that gets simplified away.
//
// `user` is a parameter, not a `request`: the helper has no way to authenticate,
// so it cannot be reached without the caller having run `requireUser` first.

import {
  addNote,
  clearFollowUp,
  createContact,
  createManyContacts,
  deleteContacts,
  listContacts,
  logTouchpoint,
  markAdsSent,
  resumeToLoop1,
  snoozeFollowUp,
  updateContactStatus,
} from "./crm.server";
import { triggerAgent } from "./hyperagent.server";
import {
  asString,
  isValidDeadReason,
  isValidStatus,
  isValidTouchType,
  LIMITS,
  validateContact,
  validateIds,
  validateImportRows,
  validateNote,
} from "./validate";

export type ContactActionResult = { ok: true; message?: string } | { ok: false; error: string };

export type ContactIntentDeps = {
  DB: D1Database;
  /** Already authenticated by the caller. Its name is recorded as note/touch author. */
  user: { name: string };
  // Empty string means "integration disabled"; triggerAgent reports that itself
  // rather than attempting a fetch. The load context already defaults them.
  HYPERAGENT_TRIGGER_URL: string;
  HYPERAGENT_API_KEY: string;
};

function parseLoopsField(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse((value ?? "[1]").toString());
  } catch {
    // ignore — validateContact treats undefined as "use the default"
  }
  return undefined;
}

function parseJsonField(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse((value ?? "[]").toString());
  } catch {
    return null;
  }
}

/**
 * Handle one contact intent.
 *
 * Returns `null` when `intent` is none of the twelve, so each route keeps its own
 * `default:` and can layer page-specific intents around this call.
 */
export async function handleContactIntent(
  form: FormData,
  deps: ContactIntentDeps,
): Promise<ContactActionResult | null> {
  const { DB, user, HYPERAGENT_TRIGGER_URL, HYPERAGENT_API_KEY } = deps;
  const intent = form.get("intent")?.toString();

  try {
    switch (intent) {
      case "setStatus": {
        const id = form.get("id")?.toString();
        const status = form.get("status")?.toString();
        if (!id || !status) return { ok: false, error: "Missing id or status." };
        // Whitelisted, matching what the machine API has always enforced. An
        // arbitrary string here isn't an injection risk (the query is bound) but
        // it silently escapes the owner filter, the queue priority ordering and
        // the cross-owner conflict check.
        if (!isValidStatus(status)) {
          return { ok: false, error: "Unknown status." };
        }
        // A reason only accompanies "Dead", and is optional even then (the picker
        // offers a Skip). Reject an unrecognised one rather than dropping it
        // silently — the analytics panel groups on this value exactly.
        const reason = form.get("reason")?.toString() || "";
        if (reason && !isValidDeadReason(reason)) {
          return { ok: false, error: "Unknown reason." };
        }
        await updateContactStatus(DB, id, status, reason || null);
        return { ok: true };
      }
      case "logTouch": {
        // Records outreach on a specific channel. Unlike addNote the text is
        // optional — logging that a call happened is useful on its own.
        const id = form.get("id")?.toString();
        const ch = form.get("ch")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        if (!isValidTouchType(ch)) return { ok: false, error: "Unknown channel." };
        const text = asString(form.get("text"));
        if (text.length > LIMITS.note) {
          return { ok: false, error: `Notes must be ${LIMITS.note} characters or fewer.` };
        }
        await logTouchpoint(DB, id, ch, user.name, text);
        return { ok: true };
      }
      case "addNote": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        const note = validateNote(form.get("text"));
        if (!note.ok) return { ok: false, error: note.error };
        await addNote(DB, id, user.name, note.text);
        return { ok: true };
      }
      case "logMeeting": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        const note = validateNote(form.get("text"));
        if (!note.ok) return { ok: false, error: note.error };
        // Save the note AND record a Meeting touchpoint in the timeline. Status
        // is left untouched (changed manually via the detail dropdown).
        await addNote(DB, id, user.name, note.text);
        await logTouchpoint(DB, id, "meeting", user.name, note.text);
        return { ok: true };
      }
      case "snooze": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        await snoozeFollowUp(DB, id);
        return { ok: true };
      }
      case "clearFollow": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        await clearFollowUp(DB, id);
        return { ok: true };
      }
      case "addContact": {
        // One validator shared with the machine API — bounds every string,
        // whitelists owner/status/loops, and checks the email format.
        const result = validateContact({
          name: form.get("name")?.toString(),
          company: form.get("company")?.toString(),
          email: form.get("email")?.toString(),
          phone: form.get("phone")?.toString(),
          linkedin: form.get("linkedin")?.toString(),
          loops: parseLoopsField(form.get("loops")),
          owner: form.get("owner")?.toString(),
          status: form.get("status")?.toString(),
          source: form.get("source")?.toString(),
        });
        if (!result.ok) return { ok: false, error: result.error };
        await createContact(DB, result.value);
        return { ok: true };
      }
      case "resumeLoop1": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        await resumeToLoop1(DB, id);
        return { ok: true };
      }
      case "markAdsSent": {
        const parsed = parseJsonField(form.get("ids"));
        if (parsed === null) {
          return { ok: false, error: "Couldn’t read the selected contacts." };
        }
        const ids = validateIds(parsed);
        if (!ids.ok) return { ok: false, error: ids.error };
        await markAdsSent(DB, ids.ids, user.name);
        return { ok: true };
      }
      case "deleteContacts": {
        // One intent for both the single-contact delete (detail panel) and the
        // bulk delete (selection bar) — the client always sends an id array.
        const parsed = parseJsonField(form.get("ids"));
        if (parsed === null) {
          return { ok: false, error: "Couldn’t read the selected contacts." };
        }
        const ids = validateIds(parsed);
        if (!ids.ok) return { ok: false, error: ids.error };
        // The signed-in user's name is recorded in audit_log alongside a snapshot
        // of each deleted row — this is a hard delete on a shared dataset.
        const removed = await deleteContacts(DB, ids.ids, user.name);
        if (!removed) return { ok: false, error: "Those contacts no longer exist." };
        return { ok: true };
      }
      case "importContacts": {
        const parsed = parseJsonField(form.get("rows"));
        if (parsed === null) {
          return { ok: false, error: "Couldn’t read the imported rows." };
        }
        // Every row is validated, not just probed with `.some()` — previously one
        // valid row admitted the whole array unchecked, with no cap on its length.
        const result = validateImportRows(parsed);
        if (!result.ok) return { ok: false, error: result.error };
        await createManyContacts(DB, result.rows);
        return {
          ok: true,
          // This message is load-bearing on the client: its presence is what
          // holds the import modal open to report the skipped rows.
          message: result.skipped
            ? `Imported ${result.rows.length}. Skipped ${result.skipped} invalid row${
                result.skipped === 1 ? "" : "s"
              }${result.firstError ? `. First problem: ${result.firstError}` : "."}`
            : undefined,
        };
      }
      case "triggerAgent": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        // Build the payload server-side from stored data so the client can't
        // spoof it. The agent writes results back via /api/hyperagent.
        const contact = (await listContacts(DB, Date.now())).find((c) => c.id === id);
        if (!contact) return { ok: false, error: "Contact not found." };
        const result = await triggerAgent(
          { url: HYPERAGENT_TRIGGER_URL, key: HYPERAGENT_API_KEY },
          {
            task: "draft_outreach",
            contact: {
              id: contact.id,
              name: contact.name,
              company: contact.company,
              email: contact.email ?? null,
              phone: contact.phone ?? null,
              linkedin: contact.linkedin ?? null,
              status: contact.status,
              loops: contact.loops,
              source: contact.source ?? null,
            },
          },
        );
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true };
      }
      default:
        return null;
    }
  } catch (err) {
    // Log the real cause, return an opaque one. See the module header.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }
}
