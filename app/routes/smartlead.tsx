import type { Route } from "./+types/smartlead";
import { SmartleadPage } from "../crm/smartlead-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import {
  buildSequencePlan,
  duplicateStatKeys,
  planImport,
  planLeads,
  statKey,
  totalStatsBySequence,
  type SequencePlan,
  type SmartleadLead,
  type SmartleadStatRow,
  type StoredSequenceStep,
} from "../crm/smartlead-map";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  appendSequenceStep,
  bindCampaign,
  clearSequenceSteps,
  createManyContacts,
  getCampaignBindings,
  listContacts,
  listPushedContactIds,
  listPushedEmails,
  listSequenceSteps,
  listSequenceStepsByLoop,
  listTemplates,
  materializeSequenceSteps,
  recordPushedLeads,
  recordVariantStats,
  removeSequenceStep,
  reorderSequenceSteps,
  saveVariant,
  setSequenceStepDelay,
  setSequenceStepVariant,
  stampCampaignSync,
  unbindCampaign,
  type CampaignBinding,
} from "../lib/crm.server";
import { rateLimit, SMARTLEAD_BUILDER_RULE, SMARTLEAD_RULE } from "../lib/ratelimit.server";
import {
  createSmartleadClient,
  isCampaignLive,
  type SmartleadCampaignRow,
} from "../lib/smartlead.server";
import {
  isValidSmartleadStatus,
  MAX_IMPORT_ROWS,
  MAX_LEAD_PUSH,
  MAX_STEP_DELAY_DAYS,
  SMARTLEAD_LEAD_CHUNK,
  SMARTLEAD_STATS_MAX_PAGES,
  SMARTLEAD_STATS_PAGE,
  validateCampaignId,
  validateCampaignName,
  validateImportRows,
  validateSchedule,
  validateStepDelay,
  validateStepOrder,
  validateStepVariant,
  validateVariantContent,
} from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Smartlead · Sales Loop CRM" },
    {
      name: "description",
      content: "Connect each sales loop to a Smartlead campaign: contacts, sequences and schedule.",
    },
  ];
}

// Same webfonts as the other CRM pages — see routes/templates.tsx.
export const links = crmFontLinks;

/** The two loops, in the order the page renders them. */
const LOOPS = [1, 2] as const;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** A template the builder can add as a step, with the slots that have copy. */
export type AddableTemplate = {
  id: string;
  name: string;
  status: string;
  sendDay: number;
  /** Slots with a subject or body — the only ones a step can be pinned to. */
  usableSlots: string[];
};

export type LoopView = {
  loop: number;
  binding: CampaignBinding | null;
  sequence: {
    included: SequencePlan["included"];
    skipped: SequencePlan["skipped"];
    problems: string[];
    warnings: string[];
    stepCount: number;
    totalDays: number;
    /**
     * True once the loop has authored steps. False means the sequence is still
     * derived from send_day and the page says so — the distinction is the whole
     * contract of the builder, and "Reset to template order" is what returns to
     * it.
     */
    custom: boolean;
    /** Every template on this loop, for the "add a step" picker. */
    addable: AddableTemplate[];
  };
  leads: {
    eligible: number;
    alreadyPushed: number;
    noEmail: number;
    inOtherCampaign: number;
    wrongStatus: Record<string, number>;
    onLoop: number;
  };
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB } = ctx;
  // Gating is per-route, so this page needs its own check.
  const user = await requireUser(request, ctx);
  const avatar = ownerAvatar(user.name);
  const now = Date.now();

  try {
    // NO Smartlead calls here, deliberately. A loader that reaches a third party
    // makes this page 500 whenever Smartlead is slow or down — and every
    // operation on it is a manual button anyway, so the live campaign list is
    // fetched by an explicit intent instead. `contacts` also feeds the shared
    // sidebar's OWNER counts, exactly as on /templates.
    const [contacts, templates, bindings, stepsByLoop] = await Promise.all([
      listContacts(DB, now),
      listTemplates(DB, now),
      getCampaignBindings(DB, now),
      listSequenceStepsByLoop(DB),
    ]);

    // Which contacts are already sequencing in each campaign. Read per bound
    // campaign so a loop's push can exclude the *other* loop's leads — a contact
    // in loops [1,2] would otherwise receive two concurrent cold sequences.
    const pushedByLoop: Record<number, Set<string>> = {};
    for (const loop of LOOPS) {
      const binding = bindings[loop];
      pushedByLoop[loop] = binding
        ? await listPushedContactIds(DB, binding.campaignId)
        : new Set<string>();
    }

    const loops: LoopView[] = LOOPS.map((loop) => {
      const steps = stepsByLoop[loop] ?? [];
      const plan = buildSequencePlan(templates, loop, steps);
      const other = loop === 1 ? 2 : 1;
      const leadPlan = planLeads(contacts, loop, pushedByLoop[loop], pushedByLoop[other]);
      return {
        loop,
        binding: bindings[loop] ?? null,
        sequence: {
          included: plan.included,
          skipped: plan.skipped,
          problems: plan.problems,
          warnings: plan.warnings,
          stepCount: plan.steps.length,
          totalDays: plan.totalDays,
          custom: steps.length > 0,
          // Concluded templates are offered too, unlike in the derived plan:
          // deliberately putting retired copy back into a sequence is a choice
          // the builder exists to allow, and the picker labels the status.
          addable: templates
            .filter((t) => t.loop === loop)
            .map((t) => ({
              id: t.id,
              name: t.name,
              status: t.status,
              sendDay: t.sendDay,
              usableSlots: t.variants
                .filter((v) => v.subject.trim() || v.body.trim())
                .map((v) => v.slot),
            })),
        },
        leads: {
          // Only the count crosses the wire — the lead payloads are rebuilt
          // server-side on push so the client can't influence who gets emailed.
          eligible: leadPlan.leads.length,
          alreadyPushed: leadPlan.alreadyPushed,
          noEmail: leadPlan.noEmail,
          inOtherCampaign: leadPlan.inOtherCampaign,
          wrongStatus: leadPlan.wrongStatus,
          onLoop: leadPlan.onLoop,
        },
      };
    });

    return {
      contacts,
      loops,
      configured: Boolean(ctx.SMARTLEAD_API_KEY),
      maxLeadPush: MAX_LEAD_PUSH,
      viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    };
  } catch (err) {
    // Surface the real cause in `wrangler tail` — the production ErrorBoundary
    // hides it, and a throw here usually means pending D1 migrations.
    console.error("[loader] failed to load smartlead:", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export type CampaignChoice = { id: string; name: string; status: string };

/**
 * Intents that reach nothing but D1 — the sequence builder and its copy editor.
 *
 * Named as a set rather than tested case by case because the rate limiter has to
 * classify the request before the switch runs. Adding a builder intent without
 * adding it here meters it against the push budget, which is the failure this
 * list exists to make visible.
 */
const BUILDER_INTENTS: ReadonlySet<string> = new Set([
  "addStep",
  "removeStep",
  "reorderSteps",
  "setStepDelay",
  "setStepVariant",
  "resetSteps",
  "saveVariant",
]);

/**
 * Resolve the token the page uses to address a step.
 *
 * A step the page DERIVED from send_day has no row and therefore no id, but it
 * is still on screen with an ✕ next to it. Rather than give the client two ways
 * to name a step, every control posts one token: the step's id when it has one,
 * or "#<position>" when it doesn't. The caller materialises first, which turns
 * the derived plan into rows in exactly the order it was rendered, so position
 * resolution is exact.
 *
 * Two people editing at once can race — a "#2" resolved against a list someone
 * else just reordered addresses the step now in position two. That is the same
 * answer the click meant ("the second step"), and every alternative requires the
 * page to have written the sequence down before it could be touched.
 */
function resolveStepToken(steps: StoredSequenceStep[], token: string): string | null {
  if (!token) return null;
  if (!token.startsWith("#")) return token;
  const position = Number(token.slice(1));
  if (!Number.isInteger(position) || position < 1 || position > steps.length) return null;
  return steps[position - 1].id;
}

type ActionResult =
  | {
      ok: true;
      message?: string;
      campaigns?: CampaignChoice[];
      /**
       * Set only by the copy editor, so the page knows to close it. Without the
       * discriminator every successful write would close it — including a
       * reorder pressed on another row — and take the half-typed body with it.
       */
      closed?: "editor";
    }
  | { ok: false; error: string };

/** Pull an array out of the several envelope shapes Smartlead answers with. */
function rowsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["data", "leads", "rows", "result"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

/** Total row count from a paginated response, or null when it doesn't say. */
function totalOf(payload: unknown): number | null {
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["total_stats", "total_leads", "total", "count"]) {
    const n = Number(obj[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * A campaign lead row arrives either flat or wrapped as `{ lead: {...} }`
 * alongside the campaign-membership fields.
 */
function unwrapLead(row: unknown): SmartleadLead {
  const obj = (row ?? {}) as Record<string, unknown>;
  const lead = (obj.lead ?? obj) as Record<string, unknown>;
  return lead as SmartleadLead;
}

function campaignChoices(rows: SmartleadCampaignRow[]): CampaignChoice[] {
  return rows
    .filter((row) => row && row.id !== undefined && row.id !== null)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name ?? "Untitled campaign"),
      status: String(row.status ?? ""),
    }));
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);
  const { DB, SMARTLEAD_API_KEY } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  // Sequence-builder edits touch nothing but D1 — no Smartlead call, no email —
  // so they are metered on their own far looser bucket. Arranging a ten-step
  // sequence is easily twenty writes, which would exhaust the push budget below
  // and leave the operator locked out of the buttons that actually cost money.
  const isBuilderEdit = BUILDER_INTENTS.has(intent ?? "");
  const limit = await rateLimit(
    DB,
    isBuilderEdit ? SMARTLEAD_BUILDER_RULE : SMARTLEAD_RULE,
    user.email,
  );
  if (!limit.allowed) {
    return {
      ok: false,
      error: `Too many Smartlead requests. Try again in ${limit.retryAfterSeconds}s.`,
    };
  }

  if (!SMARTLEAD_API_KEY) {
    return { ok: false, error: "Smartlead isn’t configured. Set the SMARTLEAD_API_KEY secret." };
  }

  const client = createSmartleadClient(SMARTLEAD_API_KEY);
  const rawLoop = Number(form.get("loop"));
  const loop = rawLoop === 1 || rawLoop === 2 ? rawLoop : 0;

  try {
    // Every intent below except fetchCampaigns needs a loop, and all but the two
    // link intents need it already bound. Resolving both once keeps the cases
    // themselves about what they actually do.
    const bindings = await getCampaignBindings(DB, Date.now());
    const binding = loop ? (bindings[loop] ?? null) : null;
    const needsLoop = intent !== "fetchCampaigns";
    if (needsLoop && !loop) return { ok: false, error: "Pick a loop first." };

    switch (intent) {
      case "fetchCampaigns": {
        const res = await client.listCampaigns();
        if (!res.ok) return { ok: false, error: res.error };
        const campaigns = campaignChoices(res.data ?? []);
        return {
          ok: true,
          campaigns,
          message: campaigns.length
            ? undefined
            : "No campaigns in this Smartlead account yet — create one below.",
        };
      }

      case "createCampaign": {
        const name = validateCampaignName(form.get("name"));
        if (!name.ok) return { ok: false, error: name.error };
        const res = await client.createCampaign(name.name);
        if (!res.ok) return { ok: false, error: res.error };
        const created = (res.data ?? {}) as Record<string, unknown>;
        const rawId = created.id ?? created.campaign_id;
        const id = validateCampaignId(rawId === undefined ? "" : String(rawId));
        if (!id.ok) {
          // The campaign may well exist in Smartlead — say so rather than
          // implying nothing happened, or the next click makes a second one.
          return {
            ok: false,
            error: "Smartlead created the campaign but didn’t return its id. Link it manually.",
          };
        }
        await bindCampaign(DB, loop, id.id, name.name);
        return { ok: true, message: `Created “${name.name}” and linked it to Loop ${loop}.` };
      }

      case "linkCampaign": {
        const id = validateCampaignId(form.get("campaignId"));
        if (!id.ok) return { ok: false, error: id.error };
        const name = validateCampaignName(form.get("campaignName"));
        if (!name.ok) return { ok: false, error: name.error };
        await bindCampaign(DB, loop, id.id, name.name);
        return { ok: true, message: `Loop ${loop} is now linked to “${name.name}”.` };
      }

      case "unlinkCampaign": {
        await unbindCampaign(DB, loop);
        return {
          ok: true,
          message: `Loop ${loop} unlinked. Nothing in Smartlead was changed or deleted.`,
        };
      }

      case "setCampaignStatus": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const status = form.get("status")?.toString() ?? "";
        if (!isValidSmartleadStatus(status)) {
          return { ok: false, error: "Unknown campaign status." };
        }
        const res = await client.setCampaignStatus(binding.campaignId, status);
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, message: `Campaign set to ${status}.` };
      }

      case "saveSchedule": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        // Parsed defensively: a malformed `days` should be "pick a sending day",
        // not the opaque reference id the outer catch would produce.
        let days: unknown = [];
        try {
          days = JSON.parse(form.get("days")?.toString() || "[]");
        } catch {
          return { ok: false, error: "Couldn’t read the sending days." };
        }
        const parsed = validateSchedule({
          timezone: form.get("timezone")?.toString(),
          days,
          startHour: form.get("startHour")?.toString(),
          endHour: form.get("endHour")?.toString(),
          minGapMinutes: form.get("minGap")?.toString(),
          maxLeadsPerDay: form.get("maxLeadsPerDay")?.toString(),
          startAt: form.get("startAt")?.toString(),
        });
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const s = parsed.value;
        const res = await client.setSchedule(binding.campaignId, {
          timezone: s.timezone,
          days_of_the_week: s.days,
          start_hour: s.startHour,
          end_hour: s.endHour,
          min_time_btw_emails: s.minGapMinutes,
          max_new_leads_per_day: s.maxLeadsPerDay,
          ...(s.startAt ? { schedule_start_time: s.startAt } : {}),
        });
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, message: "Sending schedule saved." };
      }

      /* --- Sequence builder ------------------------------------------- *
       *
       * Six intents over `smartlead_sequence_steps`, none of which calls
       * Smartlead: the builder arranges what a later "Upload sequence" will
       * send. Each one leans on materializeSequenceSteps to seed the loop from
       * the derived plan on the first edit, so the first click on a step the
       * page derived has something real to address.
       *
       * They answer quietly — `ok` with no message — except where something was
       * refused or genuinely destroyed. The step list revalidating IS the
       * feedback, and a green banner after every arrow press would bury the
       * results of the buttons that actually reach Smartlead.
       */

      case "addStep": {
        const templateId = form.get("templateId")?.toString() ?? "";
        const variant = validateStepVariant(form.get("slot") ?? "all");
        if (!variant.ok) return { ok: false, error: variant.error };

        const templates = await listTemplates(DB, Date.now());
        // Checked against THIS loop, not just existence: the picker only offers
        // the loop's own templates, but a posted id must not be able to put Loop
        // 2's copy into Loop 1's campaign.
        const template = templates.find((t) => t.id === templateId && t.loop === loop);
        if (!template) {
          return { ok: false, error: "That template isn’t on this loop any more." };
        }
        if (variant.slot && !template.variants.some((v) => v.slot === variant.slot)) {
          return { ok: false, error: `“${template.name}” has no variant ${variant.slot}.` };
        }

        const added = await appendSequenceStep(DB, loop, templates, templateId, variant.slot);
        if (!added) {
          return {
            ok: false,
            error: `That's the most steps one sequence can hold. Remove one first.`,
          };
        }
        return { ok: true };
      }

      case "removeStep": {
        const steps = await materializeSequenceSteps(DB, loop, await listTemplates(DB, Date.now()));
        // No rows means "derive from send_day", so emptying the table doesn't
        // leave an empty sequence — it silently restores every template as a
        // step. Removing the last one is refused rather than allowed to do the
        // opposite of what it says; "Reset to template order" is the button that
        // means that on purpose.
        if (steps.length <= 1) {
          return {
            ok: false,
            error:
              "A sequence needs at least one step. Add the step you want first, or press “Reset to template order”.",
          };
        }
        const stepId = resolveStepToken(steps, form.get("stepId")?.toString() ?? "");
        if (stepId) await removeSequenceStep(DB, loop, stepId);
        // A miss is not an error worth a banner: the usual cause is a second
        // click, or someone else removing the same step, and both end in the
        // state that was asked for. Revalidation shows it gone either way.
        return { ok: true };
      }

      case "reorderSteps": {
        let tokens: unknown = [];
        try {
          tokens = JSON.parse(form.get("ids")?.toString() || "[]");
        } catch {
          return { ok: false, error: "Couldn’t read the new step order." };
        }
        const order = validateStepOrder(tokens);
        if (!order.ok) return { ok: false, error: order.error };
        // Materialised first: reordering a derived plan has to write the plan
        // down before an order means anything.
        const steps = await materializeSequenceSteps(DB, loop, await listTemplates(DB, Date.now()));
        const ids = order.ids
          .map((token) => resolveStepToken(steps, token))
          .filter((id): id is string => Boolean(id));
        await reorderSequenceSteps(DB, loop, ids);
        return { ok: true };
      }

      case "setStepDelay": {
        const delay = validateStepDelay(form.get("delayDays"));
        if (!delay.ok) return { ok: false, error: delay.error };
        const steps = await materializeSequenceSteps(DB, loop, await listTemplates(DB, Date.now()));
        const stepId = resolveStepToken(steps, form.get("stepId")?.toString() ?? "");
        if (stepId) await setSequenceStepDelay(DB, loop, stepId, delay.days);
        return { ok: true };
      }

      case "setStepVariant": {
        const variant = validateStepVariant(form.get("slot"));
        if (!variant.ok) return { ok: false, error: variant.error };
        const steps = await materializeSequenceSteps(DB, loop, await listTemplates(DB, Date.now()));
        const stepId = resolveStepToken(steps, form.get("stepId")?.toString() ?? "");
        if (stepId) await setSequenceStepVariant(DB, loop, stepId, variant.slot);
        return { ok: true };
      }

      /**
       * Edit a step's copy in place.
       *
       * The same templateId + variantId + validateVariantContent + saveVariant
       * path the /templates action takes, deliberately — the copy has one home
       * (`template_variants`), and this is a second door onto it rather than a
       * second store. Which is also why the message says what it says: nothing
       * here touches Smartlead, so the campaign keeps sending the old text until
       * the sequence is uploaded again.
       */
      case "saveVariant": {
        const templateId = form.get("templateId")?.toString();
        const variantId = form.get("variantId")?.toString();
        if (!templateId || !variantId) return { ok: false, error: "Missing variant id." };
        const content = validateVariantContent({
          subject: form.get("subject")?.toString(),
          body: form.get("body")?.toString(),
        });
        if (!content.ok) return { ok: false, error: content.error };
        const saved = await saveVariant(
          DB,
          templateId,
          variantId,
          content.value.subject,
          content.value.body,
        );
        if (!saved) return { ok: false, error: "That variant no longer exists." };
        return {
          ok: true,
          closed: "editor",
          message: binding?.sequencePushedLabel
            ? "Saved to the template. Upload the sequence to send the new copy — the campaign still has the old text."
            : "Saved to the template.",
        };
      }

      case "resetSteps": {
        await clearSequenceSteps(DB, loop);
        return {
          ok: true,
          message: `Loop ${loop}'s sequence follows the templates' send days again. Nothing in Smartlead changed — upload to apply it.`,
        };
      }

      /**
       * Upload this loop's sequence as the campaign's steps.
       *
       * The order matters and each step guards a distinct failure:
       *
       *  1. Build the plan and refuse on `problems` BEFORE any API call. The
       *     critical one is an empty plan: POST /sequences replaces everything,
       *     so an empty payload doesn't no-op, it erases a live campaign's copy.
       *  2. Read the LIVE status, not the stored one — anyone can pause or start
       *     the campaign from Smartlead's own dashboard between page loads.
       *  3. Pause if it's running. Smartlead refuses sequence edits on an ACTIVE
       *     campaign with an opaque 400. If the pause itself fails, abort with
       *     nothing changed.
       *  4. Save.
       *
       * It deliberately does NOT restart a campaign it paused. Silently resuming
       * sends right after the copy changed is not a decision a button press
       * should make on the operator's behalf, and it removes the worst failure
       * mode of the alternative — a failed auto-restore leaving a live campaign
       * paused with no signal at all.
       */
      case "pushSequence": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const [templates, steps] = await Promise.all([
          listTemplates(DB, Date.now()),
          listSequenceSteps(DB, loop),
        ]);
        // Re-read rather than trusting the posted plan, and re-planned through
        // the same function the page rendered from — so the arrangement uploaded
        // is the arrangement stored, which is also the one the stats sync will
        // later attribute numbers by.
        const plan = buildSequencePlan(templates, loop, steps);
        if (plan.problems.length) return { ok: false, error: plan.problems[0] };

        const list = await client.listCampaigns();
        if (!list.ok) return { ok: false, error: list.error };
        const remote = (list.data ?? []).find((c) => String(c.id) === binding.campaignId);
        if (!remote) {
          return {
            ok: false,
            error: "That campaign no longer exists in Smartlead. Link a different one.",
          };
        }

        const wasLive = isCampaignLive(remote.status);
        if (wasLive) {
          const paused = await client.setCampaignStatus(binding.campaignId, "PAUSED");
          if (!paused.ok) {
            return {
              ok: false,
              error: `Couldn’t pause the campaign, so nothing was changed. ${paused.error}`,
            };
          }
        }

        const saved = await client.saveSequences(binding.campaignId, plan.steps);
        if (!saved.ok) {
          return {
            ok: false,
            error: wasLive
              ? `${saved.error} The campaign is now PAUSED — restart it from Smartlead when you're ready.`
              : saved.error,
          };
        }

        const summary =
          `Uploaded ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}` +
          (plan.skipped.length ? `, skipped ${plan.skipped.length}` : "") +
          ".";
        await stampCampaignSync(DB, loop, "sequence", summary);
        return {
          ok: true,
          message:
            summary +
            (wasLive
              ? " The campaign was paused for the edit — press Start when you’ve checked it."
              : ""),
        };
      }

      /**
       * Hand this loop's eligible contacts to the campaign as leads.
       *
       * The plan is rebuilt server-side rather than trusting anything posted, so
       * the client cannot widen who gets emailed. Chunks are recorded in D1 as
       * each one succeeds — never once at the end — because a failure on chunk
       * three must not lose the record that chunks one and two were already sent.
       * Re-clicking then pushes only the remainder.
       */
      case "pushContacts": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const other = loop === 1 ? 2 : 1;
        const otherBinding = bindings[other];
        const [contacts, pushed, otherPushed] = await Promise.all([
          listContacts(DB, Date.now()),
          listPushedContactIds(DB, binding.campaignId),
          otherBinding
            ? listPushedContactIds(DB, otherBinding.campaignId)
            : Promise.resolve(new Set<string>()),
        ]);

        const plan = planLeads(contacts, loop, pushed, otherPushed);
        if (!plan.leads.length) {
          return { ok: false, error: "No new contacts to push for this loop." };
        }

        // Bounded so one press can't exceed the Worker's subrequest budget. The
        // remainder is reported, and the next press picks it up.
        const take = Math.min(plan.leads.length, MAX_LEAD_PUSH);
        let sent = 0;
        let failure: string | null = null;

        for (let i = 0; i < take; i += SMARTLEAD_LEAD_CHUNK) {
          const chunk = plan.leads.slice(i, i + SMARTLEAD_LEAD_CHUNK);
          const ids = plan.contactIds.slice(i, i + SMARTLEAD_LEAD_CHUNK);
          const res = await client.addLeads(binding.campaignId, chunk);
          if (!res.ok) {
            failure = res.error;
            break;
          }
          await recordPushedLeads(
            DB,
            binding.campaignId,
            chunk.map((lead, n) => ({ contactId: ids[n], email: lead.email })),
          );
          sent += chunk.length;
        }

        const remaining = plan.leads.length - sent;
        const summary =
          `Pushed ${sent} contact${sent === 1 ? "" : "s"}` +
          (remaining > 0 ? `, ${remaining} still to go.` : ".");
        if (sent) await stampCampaignSync(DB, loop, "leads", summary);

        if (failure) {
          return sent
            ? { ok: true, message: `${summary} Smartlead then refused: ${failure}` }
            : { ok: false, error: failure };
        }
        return {
          ok: true,
          message:
            remaining > 0
              ? `${summary} Press Push again to continue.`
              : summary,
        };
      }

      /**
       * Import the campaign's leads as CRM contacts.
       *
       * Everything is handed to validateImportRows + createManyContacts — the
       * exact path a pasted CSV takes — so a remote lead is never held to a
       * different standard than a local row.
       */
      case "importLeads": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const [contacts, pushedEmails] = await Promise.all([
          listContacts(DB, Date.now()),
          listPushedEmails(DB, binding.campaignId),
        ]);

        // Both the CRM's own addresses and everything already pushed, so a
        // round-trip (push out, import back) creates nothing.
        const known = new Set(pushedEmails);
        for (const contact of contacts) {
          if (contact.email) known.add(contact.email.trim().toLowerCase());
        }

        const PAGE = 100;
        const leads: SmartleadLead[] = [];
        for (let page = 0; page < SMARTLEAD_STATS_MAX_PAGES; page++) {
          const res = await client.listLeads(binding.campaignId, page * PAGE, PAGE);
          if (!res.ok) return { ok: false, error: res.error };
          const rows = rowsOf(res.data);
          leads.push(...rows.map(unwrapLead));
          if (rows.length < PAGE || leads.length >= MAX_IMPORT_ROWS) break;
        }

        const plan = planImport(leads, known, loop, binding.campaignName || "Smartlead");
        if (!plan.rows.length) {
          return {
            ok: false,
            error: plan.total
              ? `Nothing new — all ${plan.total} leads are already in the CRM.`
              : "That campaign has no leads yet.",
          };
        }

        const validated = validateImportRows(plan.rows);
        if (!validated.ok) return { ok: false, error: validated.error };
        await createManyContacts(DB, validated.rows);

        // Link them so a later push doesn't re-send to people who came FROM the
        // campaign. Matched back by email, which is the key both sides share.
        const created = await listContacts(DB, Date.now());
        const byEmail = new Map(
          created
            .filter((c) => c.email)
            .map((c) => [c.email!.trim().toLowerCase(), c.id] as const),
        );
        await recordPushedLeads(
          DB,
          binding.campaignId,
          validated.rows
            .map((row) => {
              const email = (row.email ?? "").toLowerCase();
              return { contactId: email ? (byEmail.get(email) ?? "") : "", email };
            })
            .filter((row) => row.contactId),
        );

        const summary =
          `Imported ${validated.rows.length} contact${validated.rows.length === 1 ? "" : "s"}` +
          (plan.duplicates ? `, skipped ${plan.duplicates} already here` : "") +
          (validated.skipped ? `, skipped ${validated.skipped} invalid` : "") +
          ".";
        await stampCampaignSync(DB, loop, "leads", summary);
        return { ok: true, message: summary };
      }

      /**
       * Total the campaign's per-email rows by sequence step and write them onto
       * the matching template's variant counters.
       *
       * Two limits are reported rather than hidden. Neither is a shortcut:
       *
       *  * If the campaign has more rows than the page budget, NOTHING is
       *    written. recordVariantStats stores ABSOLUTE totals, so a partial
       *    aggregate doesn't under-report a little — it reads as performance
       *    collapsing, and feeds straight into ab.ts's z-test verdict.
       *
       *  * Statistics rows carry no variant identifier, so a template with a live
       *    A/B can't be split and is skipped by name. Its numbers stay on the
       *    manual "Record numbers" modal, which is exactly the path that exists.
       *
       * `meetings` is never passed. Smartlead has no meeting concept, and
       * validateStats' null means "leave the stored value alone" — so a figure a
       * human typed survives every sync.
       */
      case "syncStats": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const [templates, steps] = await Promise.all([
          listTemplates(DB, Date.now()),
          listSequenceSteps(DB, loop),
        ]);
        const plan = buildSequencePlan(templates, loop, steps);
        if (!plan.included.length) {
          return { ok: false, error: "No uploaded steps on this loop to attribute numbers to." };
        }

        const rows: SmartleadStatRow[] = [];
        let total: number | null = null;
        let exhausted = false;

        for (let page = 0; page < SMARTLEAD_STATS_MAX_PAGES; page++) {
          const res = await client.listStatistics(
            binding.campaignId,
            page * SMARTLEAD_STATS_PAGE,
            SMARTLEAD_STATS_PAGE,
          );
          if (!res.ok) return { ok: false, error: res.error };
          if (total === null) total = totalOf(res.data);
          const batch = rowsOf(res.data) as SmartleadStatRow[];
          rows.push(...batch);
          if (batch.length < SMARTLEAD_STATS_PAGE) break;
          if (page === SMARTLEAD_STATS_MAX_PAGES - 1) exhausted = true;
        }

        if (exhausted && total !== null && total > rows.length) {
          return {
            ok: false,
            error: `This campaign has ${total} sends — more than one sync can total. Nothing was recorded, because a partial total would read as a drop in performance.`,
          };
        }

        const bySeq = totalStatsBySequence(rows);
        const written: string[] = [];
        const skippedAb: string[] = [];
        const skippedRepeat: string[] = [];
        // The builder can put the same (template, variant) in two steps. These
        // counters are ABSOLUTE totals, so writing both would leave the template
        // reporting whichever step happened to be written last as if it were the
        // whole picture. Skipped, and said out loud.
        const repeated = duplicateStatKeys(plan.included);

        for (const step of plan.included) {
          if (step.variantCount > 1) {
            skippedAb.push(step.name);
            continue;
          }
          const key = statKey(step);
          if (key && repeated.has(key)) {
            skippedRepeat.push(`${step.name} · ${step.slots[0]}`);
            continue;
          }
          const totals = bySeq.get(step.seqNumber);
          if (!totals) continue;
          const ok = await recordVariantStats(
            DB,
            { templateId: step.templateId, slot: step.slots[0] },
            { sends: totals.sends, opens: totals.opens, replies: totals.replies, meetings: null },
          );
          if (ok) written.push(step.name);
        }

        const summary =
          `Updated ${written.length} template${written.length === 1 ? "" : "s"} from ${rows.length} sends` +
          (skippedAb.length ? `. A/B not split: ${skippedAb.join(", ")}` : "") +
          (skippedRepeat.length
            ? `. In the sequence more than once, so left alone: ${[...new Set(skippedRepeat)].join(", ")}`
            : "") +
          ".";
        await stampCampaignSync(DB, loop, "stats", summary);
        return { ok: true, message: summary };
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

export default function Smartlead({ loaderData }: Route.ComponentProps) {
  return (
    <SmartleadPage
      contacts={loaderData.contacts}
      loops={loaderData.loops}
      configured={loaderData.configured}
      maxLeadPush={loaderData.maxLeadPush}
      viewer={loaderData.viewer}
    />
  );
}
