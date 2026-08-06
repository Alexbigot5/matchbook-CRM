import type { Route } from "./+types/home";
import { SalesLoopCRM } from "../crm/sales-loop-crm";
import { appContext } from "../../load-context";
import { OWNERS } from "../crm/data";
import { requireUser } from "../lib/session.server";
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
} from "../lib/crm.server";
import { triggerAgent } from "../lib/hyperagent.server";
import {
  isValidStatus,
  validateContact,
  validateIds,
  validateImportRows,
  validateNote,
} from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sales Loop CRM" },
    {
      name: "description",
      content: "Two-loop outbound CRM — queue, contacts, and touchpoint history.",
    },
  ];
}

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Throws a redirect to /login when there's no valid, allowlisted session.
  const user = await requireUser(request, ctx);
  // Resolve the avatar server-side so the UI renders purely from loader data.
  const owner = OWNERS[user.name] ?? {
    initial: (user.name.slice(0, 1) || "?").toUpperCase(),
    color: "#b0b0aa",
  };
  try {
    return {
      contacts: await listContacts(DB, Date.now()),
      viewer: { name: user.name, initial: owner.initial, color: owner.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it. A throw here usually means the D1 schema is missing/outdated
    // (run `npm run db:migrate:remote` to apply pending migrations).
    console.error("[loader] failed to load contacts:", err);
    throw err;
  }
}

type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

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

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);
  const { DB, HYPERAGENT_TRIGGER_URL, HYPERAGENT_API_KEY } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
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
        await updateContactStatus(DB, id, status);
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
          message: result.skipped
            ? `Imported ${result.rows.length}. Skipped ${result.skipped} invalid row${
                result.skipped === 1 ? "" : "s"
              }${result.firstError ? ` — first problem: ${result.firstError}` : "."}`
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
        return { ok: false, error: "Unknown action." };
    }
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names ("no such column: source", "NOT NULL
    // constraint failed: contacts.name"), and this value is rendered straight
    // into the UI — so returning it handed the client a schema readout while
    // leaving the operator with nothing. The reference id ties the two together.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <SalesLoopCRM contacts={loaderData.contacts} viewer={loaderData.viewer} />;
}
