import type { Route } from "./+types/home";
import { SalesLoopCRM } from "../crm/sales-loop-crm";
import { appContext } from "../../load-context";
import { VIEWER } from "../crm/data";
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
import { triggerAgent } from "../lib/hyperagent.server";

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

export async function loader({ context }: Route.LoaderArgs) {
  const { DB } = context.get(appContext);
  try {
    return { contacts: await listContacts(DB, Date.now()) };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it. A throw here usually means the D1 schema is missing/outdated
    // (run `npm run db:migrate:remote` to apply pending migrations).
    console.error("[loader] failed to load contacts:", err);
    throw err;
  }
}

type ActionResult = { ok: true } | { ok: false; error: string };

function normalizeOwner(value: FormDataEntryValue | null): string | null {
  const owner = (value ?? "").toString().trim();
  if (!owner || owner === "Unassigned") return null;
  return owner;
}

function parseLoopsField(value: FormDataEntryValue | null): number[] {
  try {
    const arr = JSON.parse((value ?? "[1]").toString());
    if (Array.isArray(arr)) return arr;
  } catch {
    // ignore — fall through to default
  }
  return [1];
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const { DB, HYPERAGENT_TRIGGER_URL, HYPERAGENT_API_KEY } = context.get(appContext);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  try {
    switch (intent) {
      case "setStatus": {
        const id = form.get("id")?.toString();
        const status = form.get("status")?.toString();
        if (!id || !status) return { ok: false, error: "Missing id or status." };
        await updateContactStatus(DB, id, status);
        return { ok: true };
      }
      case "addNote": {
        const id = form.get("id")?.toString();
        const text = (form.get("text")?.toString() ?? "").trim();
        if (!id || !text) return { ok: false, error: "Missing id or note text." };
        await addNote(DB, id, VIEWER, text);
        return { ok: true };
      }
      case "logMeeting": {
        const id = form.get("id")?.toString();
        const text = (form.get("text")?.toString() ?? "").trim();
        if (!id || !text) return { ok: false, error: "Missing id or note text." };
        // Save the note AND record a Meeting touchpoint in the timeline. Status
        // is left untouched (changed manually via the detail dropdown).
        await addNote(DB, id, VIEWER, text);
        await logTouchpoint(DB, id, "meeting", VIEWER, text);
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
        const name = (form.get("name")?.toString() ?? "").trim();
        if (!name) return { ok: false, error: "Name is required." };
        await createContact(DB, {
          name,
          company: form.get("company")?.toString() ?? "",
          email: form.get("email")?.toString() ?? null,
          phone: form.get("phone")?.toString() ?? null,
          linkedin: form.get("linkedin")?.toString() ?? null,
          loops: parseLoopsField(form.get("loops")),
          owner: normalizeOwner(form.get("owner")),
          status: form.get("status")?.toString() || "New",
          source: form.get("source")?.toString() ?? null,
        });
        return { ok: true };
      }
      case "resumeLoop1": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing id." };
        await resumeToLoop1(DB, id);
        return { ok: true };
      }
      case "markAdsSent": {
        let ids: unknown;
        try {
          ids = JSON.parse(form.get("ids")?.toString() ?? "[]");
        } catch {
          return { ok: false, error: "Couldn’t read the selected contacts." };
        }
        if (!Array.isArray(ids) || !ids.length) {
          return { ok: false, error: "No contacts selected." };
        }
        await markAdsSent(DB, ids.map(String), VIEWER);
        return { ok: true };
      }
      case "importContacts": {
        let rows: NewContactInput[];
        try {
          rows = JSON.parse(form.get("rows")?.toString() ?? "[]");
        } catch {
          return { ok: false, error: "Couldn’t read the imported rows." };
        }
        if (!Array.isArray(rows) || !rows.some((r) => r?.name?.trim())) {
          return { ok: false, error: "No valid contacts to import." };
        }
        await createManyContacts(DB, rows);
        return { ok: true };
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
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
  }
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <SalesLoopCRM contacts={loaderData.contacts} />;
}
