// The /deals route. Loader mirrors lifecycle.tsx (requireUser + a read against a
// single `now`); the action owns the four deal intents.
//
// Contacts are loaded alongside the deals for two reasons: the shared sidebar's
// VIEWS and OWNER rows count contacts, and the stakeholder picker needs somebody
// to pick. Same read the /templates loader makes for the same first reason.

import type { Route } from "./+types/deals";
import { DealsPage } from "../crm/deals-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  addContactToDeal,
  createDeal,
  listContacts,
  listDeals,
  removeContactFromDeal,
  updateDealStage,
} from "../lib/crm.server";
import { isValidDealRole, isValidDealStage, validateDeal } from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Deals · Sales Loop CRM" },
    {
      name: "description",
      content: "Every open deal as a board across the pipeline stages.",
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
    const [deals, contacts] = await Promise.all([listDeals(DB), listContacts(DB, Date.now())]);
    return {
      deals,
      contacts,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it, and a throw here usually means pending D1 migrations.
    console.error("[loader] failed to load deals:", err);
    throw err;
  }
}

/**
 * `dealId` comes back from a successful createDeal so the client can open the
 * deal it just made rather than guessing "the newest one" from the revalidated
 * loader — which would race a concurrent create by one of the other users. Same
 * device as /templates' `templateId`.
 */
type ActionResult =
  | { ok: true; message?: string; dealId?: string }
  | { ok: false; error: string };

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  await requireUser(request, ctx);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  try {
    switch (intent) {
      case "createDeal": {
        const result = validateDeal({
          companyName: form.get("companyName")?.toString(),
          stage: form.get("stage")?.toString(),
          value: form.get("value")?.toString(),
          expectedCloseDate: form.get("expectedCloseDate")?.toString(),
          primaryContactId: form.get("primaryContactId")?.toString(),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const created = await createDeal(DB, result.value);
        if (!created.ok) return { ok: false, error: created.error };
        return { ok: true, dealId: created.dealId };
      }

      case "setDealStage": {
        const id = form.get("dealId")?.toString();
        const stage = form.get("stage")?.toString();
        if (!id || !stage) return { ok: false, error: "Missing deal id or stage." };
        // Checked against DEAL_STAGES, not STATUSES — deals.stage carries no CHECK
        // (see migrations/0018), so this is the only gate on the column.
        if (!isValidDealStage(stage)) return { ok: false, error: "Unknown deal stage." };
        await updateDealStage(DB, id, stage);
        return { ok: true };
      }

      case "addStakeholder": {
        const dealId = form.get("dealId")?.toString();
        const contactId = form.get("contactId")?.toString();
        const role = form.get("role")?.toString();
        if (!dealId || !contactId) return { ok: false, error: "Missing deal or contact." };
        if (!isValidDealRole(role)) {
          return { ok: false, error: "A stakeholder is either primary or secondary." };
        }
        // addContactToDeal returns its own sentence for a filled slot rather than
        // throwing, so the "already has a primary" case reaches the user intact
        // instead of being swallowed by the opaque catch below.
        return await addContactToDeal(DB, dealId, contactId, role);
      }

      case "removeStakeholder": {
        const dealId = form.get("dealId")?.toString();
        const contactId = form.get("contactId")?.toString();
        if (!dealId || !contactId) return { ok: false, error: "Missing deal or contact." };
        return await removeContactFromDeal(DB, dealId, contactId);
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names, and this value is rendered straight into the
    // UI — the reference id ties the two together.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }
}

export default function Deals({ loaderData }: Route.ComponentProps) {
  return (
    <DealsPage
      deals={loaderData.deals}
      contacts={loaderData.contacts}
      viewer={loaderData.viewer}
    />
  );
}
