import type { Route } from "./+types/lifecycle";
import { LifecyclePage } from "../crm/lifecycle-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import { listContacts, listDeals } from "../lib/crm.server";
import { handleContactIntent, type ContactActionResult } from "../lib/contact-intents.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Lifecycle · Sales Loop CRM" },
    {
      name: "description",
      content: "Every contact as a kanban board across five lifecycle stages.",
    },
  ];
}

// Same webfonts as the other CRM pages. The root route loads Inter, so without
// this the board renders in the wrong typeface.
export const links = crmFontLinks;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Gating is per-route, so this page needs its own check.
  const user = await requireUser(request, ctx);
  const avatar = ownerAvatar(user.name);
  try {
    // `deals` feeds the shared detail panel's "Also at [Company]" block — see
    // the note in home.tsx's loader for why the whole (small) set comes down.
    const [contacts, deals] = await Promise.all([listContacts(DB, Date.now()), listDeals(DB)]);
    return {
      contacts,
      deals,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it, and a throw here usually means pending D1 migrations.
    console.error("[loader] failed to load lifecycle:", err);
    throw err;
  }
}

// The board writes through the same shared intents as the contacts page, so the
// detail slide-over behaves identically on both. Being a named route, its POSTs
// need no `?index` (unlike the index route's).
export async function action({ request, context }: Route.ActionArgs): Promise<ContactActionResult> {
  const ctx = context.get(appContext);
  // Checked independently of the loader — otherwise every mutation would still
  // be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const result = await handleContactIntent(form, {
    DB: ctx.DB,
    user,
    HYPERAGENT_TRIGGER_URL: ctx.HYPERAGENT_TRIGGER_URL,
    HYPERAGENT_API_KEY: ctx.HYPERAGENT_API_KEY,
  });
  return result ?? { ok: false, error: "Unknown action." };
}

export default function Lifecycle({ loaderData }: Route.ComponentProps) {
  return (
    <LifecyclePage
      contacts={loaderData.contacts}
      deals={loaderData.deals}
      viewer={loaderData.viewer}
    />
  );
}
