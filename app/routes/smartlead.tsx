import type { Route } from "./+types/smartlead";
import { SmartleadPage } from "../crm/smartlead-page";
import { appContext } from "../../load-context";
import { ownerAvatar, type Contact } from "../crm/data";
import {
  buildOneOffStep,
  buildSequencePlan,
  duplicateStatKeys,
  planContactSends,
  planEmailEvents,
  planImport,
  planLeads,
  planOneOffLeads,
  planSenders,
  positiveCategoryNames,
  sendsByLead,
  statKey,
  totalStatsBySequence,
  type SequencePlan,
  type SmartleadEmailAccount,
  type SmartleadLead,
  type SmartleadLeadCategory,
  type SmartleadSender,
  type SmartleadStatRow,
  type StoredSequenceStep,
} from "../crm/smartlead-map";
import { matchesConditions } from "../crm/views";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  appendSequenceStep,
  bindCampaign,
  clearSequenceSteps,
  countEmailedLeads,
  createManyContacts,
  createOneOffCampaign,
  deleteOneOffCampaign,
  getCampaignBindings,
  getOneOffCampaign,
  listCampaignLeadState,
  listContacts,
  listOneOffCampaigns,
  listPushedContactIds,
  listPushedEmails,
  listSavedViews,
  listSequenceSteps,
  listSequenceStepsByLoop,
  listTemplates,
  materializeSequenceSteps,
  recordContactSends,
  recordOneOffResult,
  recordPushedLeads,
  recordVariantStats,
  removeSequenceStep,
  reorderSequenceSteps,
  saveVariant,
  setSequenceStepDelay,
  setSequenceStepVariant,
  stampCampaignSync,
  unbindCampaign,
  upsertEmailEvents,
  type CampaignBinding,
  type OneOffCampaign,
} from "../lib/crm.server";
import { rateLimit, SMARTLEAD_BUILDER_RULE, SMARTLEAD_RULE } from "../lib/ratelimit.server";
import {
  createSmartleadClient,
  isCampaignLive,
  type SmartleadCampaignRow,
  type SmartleadClient,
  type SmartleadSchedule,
} from "../lib/smartlead.server";
import {
  isValidSmartleadStatus,
  isValidVariantSlot,
  MAX_IMPORT_ROWS,
  MAX_LEAD_PUSH,
  MAX_STEP_DELAY_DAYS,
  SMARTLEAD_LEAD_CHUNK,
  SMARTLEAD_SENDER_MAX_PAGES,
  SMARTLEAD_SENDER_PAGE,
  SMARTLEAD_STATS_MAX_PAGES,
  SMARTLEAD_STATS_PAGE,
  validateCampaignId,
  validateCampaignName,
  validateEmailAccountId,
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

/** One "push only these" option: a saved view, plus what it would push now. */
export type LeadSegment = { id: string; name: string; eligible: number };

/**
 * One option in a one-off's "Email to send" picker.
 *
 * A row per usable VARIANT, not per template: a one-off sends exactly one email,
 * so an A/B template offers two options and the operator picks which copy goes
 * out. buildOneOffStep() refuses to choose for them for the same reason.
 */
export type OneOffTemplate = {
  templateId: string;
  slot: string;
  name: string;
  loop: number;
  status: string;
  /** Shown under the picker so the chosen copy can be recognised before sending. */
  subject: string;
  /**
   * The copy itself, for the picker's Preview.
   *
   * `variantId` travels for the same reason it does on `SequencePreview`: the
   * preview's Edit button writes back through the *same* saveVariant the
   * Templates page and the sequence builder use. The copy has one home
   * (`template_variants`) and this is a third door onto it, not a third store.
   */
  variantId: string;
  body: string;
};

/**
 * One audience a one-off can be sent to: everyone, or a saved view.
 *
 * `eligible` is what would actually be loaded — planOneOffLeads() applied to the
 * members — and `total` is how many contacts are in it, so the page can say why
 * the two differ rather than printing a number that looks like a bug.
 */
export type OneOffAudience = { id: string; name: string; total: number; eligible: number };

/**
 * Re-exported so the page can type its props without importing crm.server —
 * the same route-as-contract arrangement `CampaignBinding` already travels by.
 */
export type { OneOffCampaign };

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
  /**
   * The saved views this loop can be pushed a segment of, each with the number
   * of contacts that would actually go — the same planLeads() count the Push
   * button shows, narrowed to the view's members.
   *
   * Sent as counts rather than as the views' conditions because the client never
   * needs to evaluate them: picking a segment sends an id, and the action
   * re-resolves it against D1. See the note on pushContacts.
   */
  segments: LeadSegment[];
  leads: {
    eligible: number;
    alreadyPushed: number;
    /** Of those, how many Smartlead has confirmed at least one send to. */
    emailed: number;
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
    const [contacts, templates, bindings, stepsByLoop, savedViews, oneOffs] =
      await Promise.all([
        listContacts(DB, now),
        listTemplates(DB, now),
        getCampaignBindings(DB, now),
        listSequenceStepsByLoop(DB),
        // Same per-viewer read the contacts page does: shared views plus this
        // user's private ones. A segment nobody can see is a segment nobody can
        // push.
        listSavedViews(DB, user.email),
        listOneOffCampaigns(DB, now),
      ]);

    // Which contacts are already sequencing in each campaign. Read per bound
    // campaign so a loop's push can exclude the *other* loop's leads — a contact
    // in loops [1,2] would otherwise receive two concurrent cold sequences.
    const pushedByLoop: Record<number, Set<string>> = {};
    // How many of those leads Smartlead has confirmed actually receiving an
    // email. Shown next to "already in campaign" because the two numbers are
    // routinely far apart — a campaign paced at 40 new leads a day has most of
    // its pushed contacts still waiting — and the gap between them is the thing
    // an operator is really asking about when they wonder whether the sequence
    // is running.
    const emailedByLoop: Record<number, number> = {};
    for (const loop of LOOPS) {
      const binding = bindings[loop];
      pushedByLoop[loop] = binding
        ? await listPushedContactIds(DB, binding.campaignId)
        : new Set<string>();
      emailedByLoop[loop] = binding ? await countEmailedLeads(DB, binding.campaignId) : 0;
    }

    const loops: LoopView[] = LOOPS.map((loop) => {
      const steps = stepsByLoop[loop] ?? [];
      const plan = buildSequencePlan(templates, loop, steps);
      const other = loop === 1 ? 2 : 1;
      const leadPlan = planLeads(contacts, loop, pushedByLoop[loop], pushedByLoop[other]);

      // One plan per saved view, so the picker can show what each segment would
      // actually push rather than how many contacts it contains. The two numbers
      // are routinely far apart — a view of 60 Food & Beverage contacts pushes 4
      // if the other 56 are already in the campaign — and the count on the
      // button is the one an operator is deciding against.
      //
      // Views that would push nothing are kept, not filtered out. A segment
      // vanishing from the list reads as the view having been deleted; a segment
      // sitting there saying 0 says what is true, which is that everyone in it
      // has already been pushed.
      const segments: LeadSegment[] = savedViews.map((view) => ({
        id: view.id,
        name: view.name,
        eligible: planLeads(
          contacts.filter((c) => matchesConditions(c, view.conditions)),
          loop,
          pushedByLoop[loop],
          pushedByLoop[other],
        ).leads.length,
      }));

      return {
        segments,
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
          emailed: emailedByLoop[loop],
          noEmail: leadPlan.noEmail,
          inOtherCampaign: leadPlan.inOtherCampaign,
          wrongStatus: leadPlan.wrongStatus,
          onLoop: leadPlan.onLoop,
        },
      };
    });

    /*
     * One-off campaigns: the same three reads the loop cards already did, asked
     * a different question.
     *
     * The audience counts go through planOneOffLeads() rather than being contact
     * totals, because that function owns the exclusions (no address, Dead, a
     * duplicate inbox) and a chip promising 97 that loads 84 is the bug this
     * avoids. Nothing here calls Smartlead, for the same reason the rest of the
     * loader doesn't.
     */
    const oneOffTemplates: OneOffTemplate[] = templates.flatMap((template) =>
      template.variants
        .filter((v) => v.subject.trim() || v.body.trim())
        .map((v) => ({
          templateId: template.id,
          slot: v.slot,
          name: template.name,
          loop: template.loop,
          status: template.status,
          subject: v.subject,
          variantId: v.id,
          body: v.body,
        })),
    );

    // "All contacts" is first and always present; a view that would load nobody
    // is kept rather than filtered out, for the reason `segments` gives — a chip
    // reading 0 says something true, a missing chip reads as a deleted view.
    const oneOffAudiences: OneOffAudience[] = [
      {
        id: "",
        name: "All contacts",
        total: contacts.length,
        eligible: planOneOffLeads(contacts).leads.length,
      },
      ...savedViews.map((view) => {
        const members = contacts.filter((c) => matchesConditions(c, view.conditions));
        return {
          id: view.id,
          name: view.name,
          total: members.length,
          eligible: planOneOffLeads(members).leads.length,
        };
      }),
    ];

    return {
      contacts,
      loops,
      oneOffs,
      oneOffTemplates,
      oneOffAudiences,
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
 * One loop's mailboxes, as the three sender intents hand them back.
 *
 * It carries its `loop` because — unlike `campaigns`, which is the same account-
 * wide list for both cards — this is the answer for one campaign, and folding it
 * into the other card's state would show mailboxes that campaign doesn't have.
 */
export type SenderView = {
  loop: number;
  /**
   * The campaign these mailboxes were read from. The page compares it with the
   * loop's current binding before rendering the list — re-linking a loop to a
   * different campaign would otherwise leave the previous campaign's rotation on
   * screen, described as this one's, until someone pressed Fetch again.
   */
  campaignId: string;
  assigned: SmartleadSender[];
  available: SmartleadSender[];
};

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
  // Both reach D1 only: one counts an audience, the other drops a row from the
  // list. Neither sends anything, so neither belongs on the push budget.
  "loadOneOffLeads",
  "forgetOneOff",
]);

/**
 * Intents that are about a one-off campaign rather than a loop.
 *
 * A one-off has no loop — that is the whole point of migration 0024 — so these
 * are the intents that must NOT be refused by the "Pick a loop first" guard
 * below. They address a campaign by its own id instead, which is re-checked
 * against `smartlead_one_offs` so a posted id can only name a campaign this CRM
 * created.
 */
const ONE_OFF_INTENTS: ReadonlySet<string> = new Set([
  "loadOneOffLeads",
  "createOneOff",
  "setOneOffStatus",
  "syncOneOff",
  "forgetOneOff",
]);

/**
 * The schedule a one-off is created with.
 *
 * A campaign with no schedule does not send, so leaving it unset would hand back
 * a campaign that looks ready and never goes out. The values are the same
 * weekday business-hours defaults the loop cards start from, with one deliberate
 * difference: `max_new_leads_per_day` is set to the size of the list rather than
 * to a drip. A one-off is one announcement — pacing it at 40 a day would spread
 * "we're at the show next week" over a fortnight — so the whole list is released
 * and Smartlead's own `min_time_btw_emails` gap is what protects the domain.
 *
 * It is a starting point, not a mirror: the campaign's schedule belongs to
 * Smartlead the moment it exists, and the page says where to change it.
 */
const ONE_OFF_SCHEDULE: Omit<SmartleadSchedule, "max_new_leads_per_day"> = {
  timezone: "America/New_York",
  days_of_the_week: [1, 2, 3, 4, 5],
  start_hour: "09:00",
  end_hour: "17:00",
  min_time_btw_emails: 10,
};

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
      /** Set only by the sender intents. See SenderView. */
      senders?: SenderView;
      /** Set only by loadOneOffLeads. See OneOffLoad. */
      oneOffLoad?: OneOffLoad;
      /** Set by createOneOff, so the draft form knows to close and reset. */
      closedOneOff?: true;
    }
  | { ok: false; error: string };

/**
 * The recipients a one-off draft has staged, as the server counted them.
 *
 * Deliberately a round trip rather than the loader's chip count. The chips are
 * as old as the page — someone imports a CSV in another tab and the number on
 * screen is quietly wrong — and this is the figure printed directly above a
 * button that emails real people. It also carries the exclusions, which a count
 * alone can't explain: "97 loaded" next to "12 with no address, 3 unsubscribed"
 * is the difference between a believable number and a suspicious one.
 *
 * It stages nothing server-side. `createOneOff` re-resolves the audience from
 * its id, so this is a preview of that answer, not an input to it — the client
 * still names a segment and never a recipient.
 */
export type OneOffLoad = {
  audienceId: string;
  audienceName: string;
  count: number;
  noEmail: number;
  duplicates: number;
  /** Held back by status, e.g. { Dead: 3 }. */
  excluded: Record<string, number>;
};

/** Pull an array out of the several envelope shapes Smartlead answers with. */
function rowsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ["data", "leads", "email_accounts", "rows", "result"]) {
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

/**
 * Read this campaign's mailboxes and the account's, and split them.
 *
 * Both sender intents that change something re-read through this afterwards
 * rather than patching the list client-side. The rotation is Smartlead's state,
 * not ours — nothing about it is stored in D1 — so the only honest way to say
 * what a campaign sends from after a write is to ask again.
 *
 * The campaign's own list is read whole; only the account-wide list is paged,
 * and running out of pages under-offers mailboxes to assign rather than
 * misreporting the ones already assigned. `truncated` says so out loud.
 */
async function readSenders(
  client: SmartleadClient,
  campaignId: string,
  loop: number,
): Promise<
  { ok: true; view: SenderView; truncated: boolean } | { ok: false; error: string }
> {
  const mine = await client.listCampaignEmailAccounts(campaignId);
  if (!mine.ok) return { ok: false, error: mine.error };

  const account: SmartleadEmailAccount[] = [];
  let truncated = false;
  for (let page = 0; page < SMARTLEAD_SENDER_MAX_PAGES; page++) {
    const res = await client.listEmailAccounts(
      page * SMARTLEAD_SENDER_PAGE,
      SMARTLEAD_SENDER_PAGE,
    );
    if (!res.ok) return { ok: false, error: res.error };
    const rows = rowsOf(res.data) as SmartleadEmailAccount[];
    account.push(...rows);
    if (rows.length < SMARTLEAD_SENDER_PAGE) break;
    if (page === SMARTLEAD_SENDER_MAX_PAGES - 1) truncated = true;
  }

  const plan = planSenders(rowsOf(mine.data) as SmartleadEmailAccount[], account);
  return {
    ok: true,
    view: { loop, campaignId, assigned: plan.assigned, available: plan.available },
    truncated,
  };
}

/** How a mailbox is named in a result message: its address, or its id. */
function senderLabel(senders: SmartleadSender[], accountId: string): string {
  return senders.find((s) => s.accountId === accountId)?.fromEmail || `mailbox #${accountId}`;
}

/**
 * Resolve a one-off's audience id into the contacts it names.
 *
 * "" is everyone; anything else is a saved view, re-resolved here against D1
 * rather than trusted — the client says WHICH audience, the server decides WHO
 * is in it, which is the same rule pushContacts states at length. Resolving
 * through listSavedViews() settles visibility for free: someone else's private
 * view is not in this user's list, so its id resolves to nothing.
 *
 * A named-but-missing view is refused rather than widened to everyone. The
 * failure mode of the alternative is the one that matters: a stale tab blasts
 * the entire contact book because the view it meant was deleted a minute ago.
 */
async function resolveOneOffAudience(
  db: D1Database,
  email: string,
  viewId: string,
): Promise<{ ok: true; name: string; contacts: Contact[] } | { ok: false; error: string }> {
  const contacts = await listContacts(db, Date.now());
  if (!viewId) return { ok: true, name: "All contacts", contacts };

  const views = await listSavedViews(db, email);
  const view = views.find((v) => v.id === viewId);
  if (!view) {
    return { ok: false, error: "That view no longer exists. Reload and pick again." };
  }
  return {
    ok: true,
    name: view.name,
    contacts: contacts.filter((c) => matchesConditions(c, view.conditions)),
  };
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
    const needsLoop = intent !== "fetchCampaigns" && !ONE_OFF_INTENTS.has(intent ?? "");
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
            : "No campaigns in this Smartlead account yet. Create one below.",
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

      /* --- One-off campaigns -------------------------------------------- *
       *
       * A campaign with one step, created for one send. See migration 0024 for
       * why it is its own object rather than a loop binding pointed at a
       * throwaway campaign, and ONE_OFF_INTENTS above for why these five are
       * exempt from the "pick a loop first" guard.
       *
       * Everything a one-off does afterwards — its leads, its sends, the
       * touchpoints those sends become — runs through the same per-campaign
       * helpers a loop's does, because none of them ever knew about loops.
       */

      case "loadOneOffLeads": {
        const audience = await resolveOneOffAudience(
          DB,
          user.email,
          form.get("viewId")?.toString().trim() ?? "",
        );
        if (!audience.ok) return { ok: false, error: audience.error };
        const plan = planOneOffLeads(audience.contacts);
        return {
          ok: true,
          oneOffLoad: {
            audienceId: form.get("viewId")?.toString().trim() ?? "",
            audienceName: audience.name,
            count: plan.leads.length,
            noEmail: plan.noEmail,
            duplicates: plan.duplicates,
            excluded: plan.excluded,
          },
        };
      }

      /**
       * Create the campaign, upload its one email, schedule it, and load the
       * leads — in that order, because that is the order of what can be lost.
       *
       * The row in D1 is written the moment Smartlead returns an id and BEFORE
       * anything else is attempted. Every later step can fail, and a campaign
       * that exists upstream with no record here is one the operator cannot see
       * and would create a second copy of on the next press. Everything after
       * the id therefore reports what happened against a row that already
       * exists, rather than deciding whether to write one.
       *
       * It deliberately does NOT start the campaign. The whole page follows that
       * rule (see pushSequence), and it matters more here: creating and sending
       * would be a single button that mails a hundred people, with the check on
       * the copy happening afterwards.
       */
      case "createOneOff": {
        const name = validateCampaignName(form.get("name"));
        if (!name.ok) return { ok: false, error: name.error };

        const slot = form.get("slot")?.toString() ?? "";
        if (!isValidVariantSlot(slot)) {
          return { ok: false, error: "Pick which email to send." };
        }
        const templateId = form.get("templateId")?.toString() ?? "";
        const templates = await listTemplates(DB, Date.now());
        const template = templates.find((t) => t.id === templateId);
        if (!template) {
          return { ok: false, error: "That template no longer exists. Reload and pick again." };
        }
        // Built before the campaign exists, so copy with nothing in it is
        // refused without leaving an empty campaign behind in Smartlead.
        const built = buildOneOffStep(template, slot);
        if (!built.ok) return { ok: false, error: built.error };

        const viewId = form.get("viewId")?.toString().trim() ?? "";
        const audience = await resolveOneOffAudience(DB, user.email, viewId);
        if (!audience.ok) return { ok: false, error: audience.error };

        const plan = planOneOffLeads(audience.contacts);
        if (!plan.leads.length) {
          return {
            ok: false,
            error: `Nobody in "${audience.name}" can be emailed — no address on file, or held back as Dead.`,
          };
        }
        // Refused rather than truncated. A loop's push reports a remainder and
        // is pressed again; pressing Create again would make a SECOND campaign,
        // so a one-off that silently dropped everyone past the cap would be a
        // blast that quietly missed half its list.
        if (plan.leads.length > MAX_LEAD_PUSH) {
          return {
            ok: false,
            error: `${plan.leads.length} recipients is more than the ${MAX_LEAD_PUSH} one campaign can be loaded with. Narrow it with a saved view on Contacts.`,
          };
        }

        const created = await client.createCampaign(name.name);
        if (!created.ok) return { ok: false, error: created.error };
        const raw = (created.data ?? {}) as Record<string, unknown>;
        const rawId = raw.id ?? raw.campaign_id;
        const campaignId = validateCampaignId(rawId === undefined ? "" : String(rawId));
        if (!campaignId.ok) {
          return {
            ok: false,
            error:
              "Smartlead created the campaign but didn’t return its id, so nothing could be loaded into it. Finish or delete it in Smartlead.",
          };
        }

        await createOneOffCampaign(DB, {
          campaignId: campaignId.id,
          campaignName: name.name,
          templateId: template.id,
          variantSlot: slot,
          audience: audience.name,
          createdBy: user.name,
        });

        const sequence = await client.saveSequences(campaignId.id, [built.step]);
        if (!sequence.ok) {
          const failure = `The email couldn’t be uploaded: ${sequence.error}`;
          await recordOneOffResult(DB, campaignId.id, { result: failure });
          return {
            ok: false,
            error: `“${name.name}” now exists in Smartlead with no email on it and no leads. ${sequence.error} Finish or delete it there.`,
          };
        }

        // Not fatal: the campaign holds the right copy and the right people, and
        // a schedule is set in one place in Smartlead's own UI. Reported, so
        // nobody presses Start on a campaign that can't pace itself.
        const schedule = await client.setSchedule(campaignId.id, {
          ...ONE_OFF_SCHEDULE,
          max_new_leads_per_day: plan.leads.length,
        });

        let sent = 0;
        let failure: string | null = null;
        for (let i = 0; i < plan.leads.length; i += SMARTLEAD_LEAD_CHUNK) {
          const chunk = plan.leads.slice(i, i + SMARTLEAD_LEAD_CHUNK);
          const ids = plan.contactIds.slice(i, i + SMARTLEAD_LEAD_CHUNK);
          const res = await client.addLeads(campaignId.id, chunk);
          if (!res.ok) {
            failure = res.error;
            break;
          }
          // After each chunk, never once at the end — the same rule pushContacts
          // follows, and the reason a retry can't email anyone twice.
          await recordPushedLeads(
            DB,
            campaignId.id,
            chunk.map((lead, n) => ({ contactId: ids[n], email: lead.email })),
          );
          sent += chunk.length;
        }

        const summary =
          `Loaded ${sent} of ${plan.leads.length} lead${plan.leads.length === 1 ? "" : "s"} ` +
          `from ${audience.name}, sending “${template.name}” variant ${slot}.` +
          (failure ? ` Smartlead then refused the rest: ${failure}` : "") +
          (schedule.ok ? "" : ` The schedule couldn't be set: ${schedule.error}`);
        await recordOneOffResult(DB, campaignId.id, { leadCount: sent, result: summary });

        return {
          ok: true,
          closedOneOff: true,
          message:
            `Created “${name.name}” and loaded ${sent} lead${sent === 1 ? "" : "s"}. ` +
            `Nothing has been sent: assign a mailbox to it in Smartlead, check the copy, then press Start.` +
            (failure ? ` Smartlead refused the remaining leads: ${failure}` : "") +
            (schedule.ok ? "" : ` The sending schedule couldn't be set: ${schedule.error}`),
        };
      }

      case "setOneOffStatus": {
        const status = form.get("status")?.toString() ?? "";
        if (!isValidSmartleadStatus(status)) {
          return { ok: false, error: "Unknown campaign status." };
        }
        // Resolved against our own table rather than taken from the form: this
        // is the one intent that can start real sending, and a posted id must
        // only ever name a campaign this CRM created.
        const oneOff = await getOneOffCampaign(DB, form.get("campaignId")?.toString() ?? "");
        if (!oneOff) return { ok: false, error: "That campaign isn’t one of these." };

        const res = await client.setCampaignStatus(oneOff.campaignId, status);
        if (!res.ok) return { ok: false, error: res.error };
        const message = `“${oneOff.campaignName}” set to ${status}.`;
        await recordOneOffResult(DB, oneOff.campaignId, { result: message });
        return { ok: true, message };
      }

      /**
       * Read back what a one-off actually sent.
       *
       * Two of syncStats' three halves, and deliberately not the third. Storing
       * the per-email rows and marking the contacts are per-row facts keyed on an
       * id, so they behave identically for a one-off. The TEMPLATE COUNTERS are
       * not: they are absolute lifetime totals per (template, slot), and a
       * one-off usually reuses copy a loop campaign is also sending — writing the
       * blast's numbers there would replace the sequence's totals with the
       * blast's, which is the same failure duplicateStatKeys() exists to prevent,
       * arriving from a different direction. So they are left alone, and the page
       * says so rather than leaving someone to wonder why /templates didn't move.
       */
      case "syncOneOff": {
        const oneOff = await getOneOffCampaign(DB, form.get("campaignId")?.toString() ?? "");
        if (!oneOff) return { ok: false, error: "That campaign isn’t one of these." };

        const leadState = await listCampaignLeadState(DB, oneOff.campaignId);
        // Same non-fatal read syncStats makes: without it categories are still
        // stored verbatim and is_positive stays 0, which is a gap the result line
        // names rather than a zero it reports as a finding.
        const categoryRes = await client.listLeadCategories();
        const positive = categoryRes.ok
          ? positiveCategoryNames(rowsOf(categoryRes.data) as SmartleadLeadCategory[])
          : null;

        const rows: SmartleadStatRow[] = [];
        let storedEvents = 0;
        let unkeyedRows = 0;
        const syncedAt = new Date().toISOString();

        for (let page = 0; page < SMARTLEAD_STATS_MAX_PAGES; page++) {
          const res = await client.listStatistics(
            oneOff.campaignId,
            page * SMARTLEAD_STATS_PAGE,
            SMARTLEAD_STATS_PAGE,
          );
          if (!res.ok) return { ok: false, error: res.error };
          const batch = rowsOf(res.data) as SmartleadStatRow[];
          rows.push(...batch);

          const planned = planEmailEvents(batch, oneOff.campaignId, positive, syncedAt);
          unkeyedRows += planned.skipped;
          storedEvents += await upsertEmailEvents(DB, planned.events, syncedAt);

          if (batch.length < SMARTLEAD_STATS_PAGE) break;
        }

        const sends = planContactSends(leadState, sendsByLead(rows));
        const marked = await recordContactSends(
          DB,
          oneOff.campaignId,
          oneOff.campaignName,
          sends,
          user.name,
        );

        const summary =
          (marked.touchpoints
            ? `Logged ${marked.touchpoints} send${marked.touchpoints === 1 ? "" : "s"} onto ` +
              `${sends.length} contact${sends.length === 1 ? "" : "s"}` +
              (marked.contacted ? `, ${marked.contacted} now Contacted. ` : ". ")
            : "No new sends to record onto contacts. ") +
          (storedEvents
            ? `Stored ${storedEvents} email row${storedEvents === 1 ? "" : "s"}`
            : "No email rows to store") +
          (unkeyedRows ? `, ${unkeyedRows} without an id skipped` : "") +
          (positive === null ? ", lead sentiment could not be read this time" : "") +
          ". Template numbers are left alone for a one-off.";
        await recordOneOffResult(DB, oneOff.campaignId, { result: summary, stampSync: true });
        return { ok: true, message: summary };
      }

      case "forgetOneOff": {
        const id = form.get("oneOffId")?.toString() ?? "";
        if (!id) return { ok: false, error: "Missing campaign id." };
        await deleteOneOffCampaign(DB, id);
        return {
          ok: true,
          message:
            "Removed from this list. Nothing in Smartlead was changed or deleted, and the contacts it emailed keep their timeline.",
        };
      }

      /* --- Senders (the mailboxes the campaign sends from) -------------- *
       *
       * Read-and-assign only. Buying or connecting a mailbox is Smartlead's job,
       * the same way the campaign, the leads and the templates are things this
       * page points at rather than creates — these three intents only decide
       * which of the account's existing mailboxes this loop's campaign rotates
       * between.
       *
       * Nothing is written to D1, so nothing is stamped: there is no local copy
       * of the rotation that could go stale, and every answer below is a fresh
       * read handed straight back to the card.
       */

      case "fetchSenders": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const senders = await readSenders(client, binding.campaignId, loop);
        if (!senders.ok) return { ok: false, error: senders.error };
        const { assigned, available } = senders.view;
        return {
          ok: true,
          senders: senders.view,
          message: assigned.length
            ? undefined
            : "This campaign has no mailboxes assigned, so Smartlead can't send it. Assign one below." +
              (available.length ? "" : " There are none connected to this Smartlead account yet."),
        };
      }

      case "assignSender": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const account = validateEmailAccountId(form.get("accountId"));
        if (!account.ok) return { ok: false, error: account.error };

        const res = await client.assignEmailAccountToCampaign(binding.campaignId, account.id);
        if (!res.ok) return { ok: false, error: res.error };

        // Re-read rather than moving the row across two client-side lists: the
        // write may have landed differently than it reads (a mailbox already on
        // the campaign, one disconnected since the fetch), and the list on
        // screen is a claim about what will send the next email.
        const senders = await readSenders(client, binding.campaignId, loop);
        if (!senders.ok) {
          return {
            ok: true,
            message: `Assigned the mailbox, but couldn't re-read the list: ${senders.error}`,
          };
        }
        const name = senderLabel(senders.view.assigned, account.id);
        return {
          ok: true,
          senders: senders.view,
          message: `${name} now sends Loop ${loop}'s campaign. ${senders.view.assigned.length} mailbox${
            senders.view.assigned.length === 1 ? "" : "es"
          } in the rotation.`,
        };
      }

      case "removeSender": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const account = validateEmailAccountId(form.get("accountId"));
        if (!account.ok) return { ok: false, error: account.error };

        const res = await client.removeEmailAccountFromCampaign(binding.campaignId, account.id);
        if (!res.ok) return { ok: false, error: res.error };

        const senders = await readSenders(client, binding.campaignId, loop);
        if (!senders.ok) {
          return {
            ok: true,
            message: `Removed the mailbox, but couldn't re-read the list: ${senders.error}`,
          };
        }
        // Named from the list it landed in — it is unassigned now, so it is on
        // the available side.
        const name = senderLabel(senders.view.available, account.id);
        const left = senders.view.assigned.length;
        return {
          ok: true,
          senders: senders.view,
          // Emptying the rotation is allowed — swapping every mailbox has to
          // pass through zero — but a campaign with no sender cannot send, and
          // Smartlead reports that as nothing happening rather than as an error.
          message:
            `${name} no longer sends Loop ${loop}'s campaign. The mailbox itself is untouched.` +
            (left
              ? ` ${left} mailbox${left === 1 ? "" : "es"} still in the rotation.`
              : " Nothing is left in the rotation, so this campaign can't send until you assign one."),
        };
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
            ? "Saved to the template. Upload the sequence to send the new copy; the campaign still has the old text."
            : "Saved to the template.",
        };
      }

      case "resetSteps": {
        await clearSequenceSteps(DB, loop);
        return {
          ok: true,
          message: `Loop ${loop}'s sequence follows the templates' send days again. Nothing in Smartlead changed; upload to apply it.`,
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
              ? `${saved.error} The campaign is now PAUSED. Restart it from Smartlead when you're ready.`
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
              ? " The campaign was paused for the edit. Press Start when you’ve checked it."
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
      /**
       * Push this loop's contacts, or just one saved view's worth of them.
       *
       * `viewId` is an id, never a list of contacts, and it is re-resolved here
       * against D1 rather than trusted: the client says WHICH segment, the
       * server decides WHO is in it. That is the same rule the loader's comment
       * states about lead payloads, and it is what stops a hand-made POST from
       * naming its own recipients. Resolving through listSavedViews also settles
       * visibility for free — a private view belonging to someone else is not in
       * this user's list, so its id resolves to nothing.
       */
      case "pushContacts": {
        if (!binding) return { ok: false, error: "Link a campaign first." };
        const other = loop === 1 ? 2 : 1;
        const otherBinding = bindings[other];
        const viewId = form.get("viewId")?.toString().trim() ?? "";
        const [allContacts, pushed, otherPushed, savedViews] = await Promise.all([
          listContacts(DB, Date.now()),
          listPushedContactIds(DB, binding.campaignId),
          otherBinding
            ? listPushedContactIds(DB, otherBinding.campaignId)
            : Promise.resolve(new Set<string>()),
          viewId ? listSavedViews(DB, user.email) : Promise.resolve([]),
        ]);

        // A named-but-missing view is refused, not silently widened to the whole
        // loop. The failure mode of the alternative is the one that matters
        // here: a stale tab pushes the entire contact book at a campaign because
        // the segment it meant was deleted a minute ago.
        const view = viewId ? savedViews.find((v) => v.id === viewId) ?? null : null;
        if (viewId && !view) {
          return { ok: false, error: "That view no longer exists. Reload and pick again." };
        }

        const contacts = view
          ? allContacts.filter((c) => matchesConditions(c, view.conditions))
          : allContacts;

        const plan = planLeads(contacts, loop, pushed, otherPushed);
        if (!plan.leads.length) {
          return {
            ok: false,
            error: view
              ? `No new contacts to push in "${view.name}".`
              : "No new contacts to push for this loop.",
          };
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
          (view ? ` from "${view.name}"` : "") +
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
              ? `Nothing new: all ${plan.total} leads are already in the CRM.`
              : "That campaign has no leads yet.",
          };
        }

        const validated = validateImportRows(plan.rows);
        if (!validated.ok) return { ok: false, error: validated.error };
        const { inserted } = await createManyContacts(DB, validated.rows);

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
          `Imported ${inserted} contact${inserted === 1 ? "" : "s"}` +
          (plan.duplicates ? `, skipped ${plan.duplicates} already here` : "") +
          (validated.skipped ? `, skipped ${validated.skipped} invalid` : "") +
          ".";
        await stampCampaignSync(DB, loop, "leads", summary);
        return { ok: true, message: summary };
      }

      /**
       * Read the campaign's per-email rows and put them to work three ways:
       * store each row (migration 0022), mark the contacts that were emailed
       * (migration 0015), and total them by step onto the template counters
       * (migration 0008).
       *
       * The three halves are ordered by how they fail, not by importance. Row
       * storage and contact marking are per-row facts keyed on an id, so a
       * partial read applies partially and correctly; the template counters are
       * absolute lifetime totals, so a partial read must write nothing.
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
        const [templates, steps, leadState] = await Promise.all([
          listTemplates(DB, Date.now()),
          listSequenceSteps(DB, loop),
          listCampaignLeadState(DB, binding.campaignId),
        ]);
        const plan = buildSequencePlan(templates, loop, steps);

        /*
         * Lead sentiment, read once for the whole sync.
         *
         * This is the only thing that says whether a `lead_category` on a
         * statistics row means the lead answered WELL — the built-in
         * "Interested" is obvious, a team's own "Warm intro" is not, and only
         * `sentiment_type` knows. A failure here is deliberately NOT fatal: the
         * categories are still stored verbatim, `is_positive` is left at 0, and
         * the result line says sentiment could not be resolved, rather than the
         * page reporting zero positive replies as though that were the finding.
         */
        const categoryRes = await client.listLeadCategories();
        const positive = categoryRes.ok
          ? positiveCategoryNames(rowsOf(categoryRes.data) as SmartleadLeadCategory[])
          : null;

        const rows: SmartleadStatRow[] = [];
        let total: number | null = null;
        let exhausted = false;
        let storedEvents = 0;
        let unkeyedRows = 0;
        // One instant for every row this sync writes, so "when did we last see
        // this campaign" is a single answer rather than a spread of timestamps.
        const syncedAt = new Date().toISOString();

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

          /*
           * Half zero: keep the rows themselves (migration 0022).
           *
           * Written HERE, per page, rather than after the loop — and unlike the
           * template counters below it is not gated by the page budget at all.
           * These rows are keyed on Smartlead's own stats_id, so a short read
           * stores fewer emails and never a wrong one, and the next press picks
           * up the rest. That is the same argument the contact half makes, and
           * it is the whole reason absolute counters and per-row facts are
           * treated differently.
           */
          const planned = planEmailEvents(batch, binding.campaignId, positive, syncedAt);
          unkeyedRows += planned.skipped;
          storedEvents += await upsertEmailEvents(DB, planned.events, syncedAt);

          if (batch.length < SMARTLEAD_STATS_PAGE) break;
          if (page === SMARTLEAD_STATS_MAX_PAGES - 1) exhausted = true;
        }

        const eventSummary =
          (storedEvents
            ? `Stored ${storedEvents} email row${storedEvents === 1 ? "" : "s"}`
            : "No email rows to store") +
          (unkeyedRows ? `, ${unkeyedRows} without an id skipped` : "") +
          (positive === null ? ", lead sentiment could not be read this time" : "") +
          ".";

        /*
         * Half one: the sends land on the CONTACTS they were sent to.
         *
         * This runs before the template totals and is not gated by either of
         * their guards, because the two halves fail differently. A template
         * counter is an absolute lifetime total, so a half-read campaign must
         * write nothing. A contact's "we emailed this person" is a per-person
         * fact keyed on the sequence step: reading only the first pages marks
         * fewer people, never the wrong one, and the next press picks up the
         * rest. Refusing to mark anyone because the OTHER half can't be totalled
         * would leave contacts reading "New" months after a campaign emailed
         * them, which is the bug this exists to fix.
         */
        const sends = planContactSends(leadState, sendsByLead(rows));
        const marked = await recordContactSends(
          DB,
          binding.campaignId,
          binding.campaignName,
          sends,
          user.name,
        );
        const contactSummary = marked.touchpoints
          ? `Logged ${marked.touchpoints} send${marked.touchpoints === 1 ? "" : "s"} onto ` +
            `${sends.length} contact${sends.length === 1 ? "" : "s"}` +
            (marked.contacted
              ? `, ${marked.contacted} now Contacted.`
              : ".")
          : "No new sends to record onto contacts.";

        // Half two: the same rows, totalled by step onto the template counters.
        let statsSummary: string;
        if (!plan.included.length) {
          statsSummary = "No uploaded steps on this loop to attribute numbers to.";
        } else if (exhausted && total !== null && total > rows.length) {
          statsSummary =
            `Template numbers were left alone: this campaign has ${total} sends, more than ` +
            `one sync can total, and a partial total would read as a drop in performance.`;
        } else {
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

          statsSummary =
            `Updated ${written.length} template${written.length === 1 ? "" : "s"} from ${rows.length} sends` +
            (skippedAb.length ? `. A/B not split: ${skippedAb.join(", ")}` : "") +
            (skippedRepeat.length
              ? `. In the sequence more than once, so left alone: ${[...new Set(skippedRepeat)].join(", ")}`
              : "") +
            ".";
        }

        const summary = `${statsSummary} ${contactSummary} ${eventSummary}`;
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
      oneOffs={loaderData.oneOffs}
      oneOffTemplates={loaderData.oneOffTemplates}
      oneOffAudiences={loaderData.oneOffAudiences}
      configured={loaderData.configured}
      maxLeadPush={loaderData.maxLeadPush}
      viewer={loaderData.viewer}
    />
  );
}
