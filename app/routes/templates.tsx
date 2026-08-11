import type { Route } from "./+types/templates";
import { TemplatesPage } from "../crm/templates-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { UNTITLED } from "../crm/templates";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  addVariant,
  createTemplate,
  deleteTemplate,
  listContacts,
  listTemplates,
  promoteVariant,
  recordVariantStats,
  removeVariant,
  saveVariant,
  setTemplateStatus,
  updateTemplate,
} from "../lib/crm.server";
import {
  isValidLoop,
  isValidTemplateStatus,
  validateStats,
  validateTemplate,
  validateVariantContent,
  validateVariantTarget,
} from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Email templates · Sales Loop CRM" },
    {
      name: "description",
      content: "Outbound email templates and their A/B test results across both sales loops.",
    },
  ];
}

// Same webfonts as the other CRM pages. The root route loads Inter, so without
// this the page renders in the wrong typeface and every mono figure falls back.
export const links = crmFontLinks;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Gating is per-route, so this page needs its own check.
  const user = await requireUser(request, ctx);
  const avatar = ownerAvatar(user.name);
  // One reference instant for both reads, so the contact date math and the
  // templates' "running Nd" agree on where today starts.
  const now = Date.now();
  try {
    // `contacts` is read only to feed the shared sidebar's OWNER counts — this
    // page's own data is `templates`.
    const [contacts, templates] = await Promise.all([
      listContacts(DB, now),
      listTemplates(DB, now),
    ]);
    return {
      contacts,
      templates,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it, and a throw here usually means pending D1 migrations.
    console.error("[loader] failed to load templates:", err);
    throw err;
  }
}

/**
 * `templateId` is returned by `createTemplate` so the client can select the
 * template it just made. Guessing "the newest one" from the revalidated loader
 * data would race a concurrent create by one of the other users.
 */
type ActionResult =
  | { ok: true; message?: string; templateId?: string }
  | { ok: false; error: string };

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
      case "createTemplate": {
        // Born as a draft named UNTITLED on the loop the user is filtering by, so
        // "+ New" while viewing Loop 2 doesn't silently create a Loop 1 template.
        const rawLoop = Number(form.get("loop"));
        const loop = isValidLoop(rawLoop) ? rawLoop : 1;
        const id = await createTemplate(DB, { name: UNTITLED, loop, sendDay: 0 });
        return { ok: true, templateId: id };
      }
      case "updateTemplate": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing template id." };
        const result = validateTemplate({
          name: form.get("name")?.toString(),
          loop: form.get("loop")?.toString(),
          sendDay: form.get("sendDay")?.toString(),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const updated = await updateTemplate(DB, id, result.value);
        if (!updated) return { ok: false, error: "That template no longer exists." };
        return { ok: true };
      }
      case "setTemplateStatus": {
        const id = form.get("id")?.toString();
        const status = form.get("status")?.toString();
        if (!id || !status) return { ok: false, error: "Missing id or status." };
        if (!isValidTemplateStatus(status)) {
          return { ok: false, error: "Unknown template status." };
        }
        const updated = await setTemplateStatus(DB, id, status);
        if (!updated) return { ok: false, error: "That template no longer exists." };
        return { ok: true };
      }
      case "saveVariant": {
        const templateId = form.get("templateId")?.toString();
        const variantId = form.get("variantId")?.toString();
        if (!templateId || !variantId) return { ok: false, error: "Missing variant id." };
        const result = validateVariantContent({
          subject: form.get("subject")?.toString(),
          body: form.get("body")?.toString(),
        });
        if (!result.ok) return { ok: false, error: result.error };
        const saved = await saveVariant(
          DB,
          templateId,
          variantId,
          result.value.subject,
          result.value.body,
        );
        if (!saved) return { ok: false, error: "That variant no longer exists." };
        return { ok: true };
      }
      case "addVariant": {
        const templateId = form.get("templateId")?.toString();
        if (!templateId) return { ok: false, error: "Missing template id." };
        const added = await addVariant(DB, templateId, "B");
        if (!added.ok) {
          return {
            ok: false,
            error:
              added.reason === "exists"
                ? "This template already has a variant B."
                : "That template no longer exists.",
          };
        }
        return { ok: true };
      }
      case "removeVariant": {
        const templateId = form.get("templateId")?.toString();
        const variantId = form.get("variantId")?.toString();
        if (!templateId || !variantId) return { ok: false, error: "Missing variant id." };
        const removed = await removeVariant(DB, templateId, variantId, user.name);
        if (!removed.ok) {
          return {
            ok: false,
            error:
              removed.reason === "slotA"
                ? "Variant A can't be removed."
                : removed.reason === "lastVariant"
                  ? "A template needs at least one variant."
                  : "That variant no longer exists.",
          };
        }
        return { ok: true };
      }
      case "promoteVariant": {
        const templateId = form.get("templateId")?.toString();
        const variantId = form.get("variantId")?.toString();
        if (!templateId || !variantId) return { ok: false, error: "Missing variant id." };
        const promoted = await promoteVariant(DB, templateId, variantId);
        if (!promoted) return { ok: false, error: "That variant no longer exists." };
        return { ok: true };
      }
      case "recordStats": {
        // Same two validators the machine API uses, in the same order.
        const target = validateVariantTarget({
          templateId: form.get("templateId")?.toString(),
          variantId: form.get("variantId")?.toString(),
          slot: form.get("slot")?.toString(),
        });
        if (!target.ok) return { ok: false, error: target.error };
        const stats = validateStats({
          sends: form.get("sends")?.toString(),
          opens: form.get("opens")?.toString(),
          replies: form.get("replies")?.toString(),
          meetings: form.get("meetings")?.toString(),
        });
        if (!stats.ok) return { ok: false, error: stats.error };
        const recorded = await recordVariantStats(DB, target.value, stats.value);
        if (!recorded) return { ok: false, error: "That variant no longer exists." };
        return { ok: true };
      }
      case "deleteTemplate": {
        const id = form.get("id")?.toString();
        if (!id) return { ok: false, error: "Missing template id." };
        const removed = await deleteTemplate(DB, id, user.name);
        if (!removed) return { ok: false, error: "That template no longer exists." };
        return { ok: true };
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

export default function Templates({ loaderData }: Route.ComponentProps) {
  return (
    <TemplatesPage
      contacts={loaderData.contacts}
      templates={loaderData.templates}
      viewer={loaderData.viewer}
    />
  );
}
