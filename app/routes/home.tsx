import type { Route } from "./+types/home";
import { SalesLoopCRM } from "../crm/sales-loop-crm";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  createSavedView,
  deleteSavedView,
  listContacts,
  listDeals,
  listSavedViews,
} from "../lib/crm.server";
import { handleContactIntent } from "../lib/contact-intents.server";
import { MAX_SAVED_VIEWS, validateSavedView } from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sales Loop CRM" },
    {
      name: "description",
      content: "Two-loop outbound CRM: queue, contacts, and touchpoint history.",
    },
  ];
}

export const links = crmFontLinks;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Throws a redirect to /login when there's no valid, allowlisted session.
  const user = await requireUser(request, ctx);
  // Resolve the avatar server-side so the UI renders purely from loader data.
  const avatar = ownerAvatar(user.name);
  try {
    // Saved views are read per-viewer: shared ones plus this user's private ones.
    // Deals are read here purely to power the detail panel's "Also at [Company]"
    // block. It is a small table and the panel needs whichever company the user
    // happens to click, which the loader cannot know — so the whole set comes
    // down once rather than a round trip per panel open.
    const [contacts, savedViews, deals] = await Promise.all([
      listContacts(DB, Date.now()),
      listSavedViews(DB, user.email),
      listDeals(DB),
    ]);
    return {
      contacts,
      savedViews,
      deals,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it. A throw here usually means the D1 schema is missing/outdated
    // (run `npm run db:migrate:remote` to apply pending migrations).
    console.error("[loader] failed to load contacts:", err);
    throw err;
  }
}

/**
 * `savedViewId` is returned by a successful createSavedView so the client can
 * select the view it just made — guessing "the newest one" from the revalidated
 * loader would race a concurrent save by one of the other users. It also acts as
 * the discriminator that tells the client's settle effect this success was a view
 * save and not some unrelated intent. Same device as /templates' `templateId`.
 */
type ActionResult =
  | { ok: true; message?: string; savedViewId?: string }
  | { ok: false; error: string };

function parseJson(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse((value ?? "null").toString());
  } catch {
    return null;
  }
}

/**
 * Contact intents live in ../lib/contact-intents.server.ts, shared with /lifecycle
 * so the detail slide-over behaves identically wherever it is rendered.
 *
 * The two saved-view intents are handled here rather than there on purpose: a
 * saved view is page configuration, not a contact write, and only this page
 * renders the builder. `handleContactIntent` returns null for an intent it does
 * not know precisely so a route can layer its own around it — see its docblock.
 * They carry their own try/catch because that helper's is internal to it, so an
 * error here would otherwise escape and hand the client D1's table and column
 * names.
 */
export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  try {
    switch (intent) {
      case "createSavedView": {
        const result = validateSavedView({
          name: form.get("name")?.toString(),
          shared: form.get("shared")?.toString(),
          conditions: parseJson(form.get("conditions")),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const created = await createSavedView(DB, result.value, {
          email: user.email,
          name: user.name,
        });
        if (!created.ok) {
          return { ok: false, error: `You can save up to ${MAX_SAVED_VIEWS} views.` };
        }
        return { ok: true, savedViewId: created.id };
      }
      case "deleteSavedView": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing view id." };
        const removed = await deleteSavedView(DB, id, user.email, user.name);
        if (!removed) return { ok: false, error: "That view no longer exists." };
        return { ok: true };
      }
    }
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names, and this value is rendered straight into the
    // UI — the reference id ties the two together.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }

  const result = await handleContactIntent(form, {
    DB,
    user,
    HYPERAGENT_TRIGGER_URL: ctx.HYPERAGENT_TRIGGER_URL,
    HYPERAGENT_API_KEY: ctx.HYPERAGENT_API_KEY,
  });
  return result ?? { ok: false, error: "Unknown action." };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <SalesLoopCRM
      contacts={loaderData.contacts}
      savedViews={loaderData.savedViews}
      deals={loaderData.deals}
      viewer={loaderData.viewer}
    />
  );
}
