// Pure, isomorphic translation between this CRM's model and Smartlead's.
//
// Same contract as ./ab.ts and ./lifecycle.ts: no React, no server imports, and
// **no `Date`**. Everything the /smartlead page renders — the step list, the
// counts, the skip reasons — is precomputed here so the page stays a plain
// mapper and SSR matches hydration.
//
// Three Smartlead behaviours shape almost every decision below. They are not
// obvious from its docs and each one has a wrong-looking-but-correct consequence:
//
//  1. POST /campaigns/{id}/sequences REPLACES the entire sequence. There is no
//     partial update, so buildSequencePlan always emits every step, and the UI
//     has to warn before firing it.
//
//  2. `seq_delay_details.delay_in_days` is the wait BEFORE a step, relative to the
//     previous step — not an absolute offset from day zero. A CRM template set
//     "day 7" following one set "day 3" is a delay of 4, not 7. Copying send_day
//     straight across stretches every sequence.
//
//  3. A step with a single variant must carry `subject`/`email_body` flat on the
//     step. Smartlead rejects a one-entry `seq_variants`, so the A/B and the
//     solo cases genuinely are two different shapes.

import type { Contact } from "./data";
import type { EmailTemplate } from "./templates";

// ---------------------------------------------------------------------------
// Sequences (CRM templates -> Smartlead campaign steps)
// ---------------------------------------------------------------------------

/**
 * Key names inside a `seq_variants` entry, in one place.
 *
 * Smartlead's published examples and its actual validator have disagreed about
 * `variant_id` vs `variant_label` (and about the distribution key) across
 * versions. Every one of them is spelled once, here, so correcting a rejected
 * push is a one-line change rather than a hunt through the builder. Verify by
 * pushing to a scratch campaign and reading `GET /campaigns/{id}/sequences` back.
 */
export const SEQ_VARIANT_KEYS = {
  id: "variant_id",
  subject: "subject",
  body: "email_body",
  distribution: "distribution",
} as const;

export type SequenceVariantPayload = Record<string, string | number>;

export type SequenceStep = {
  /**
   * Smartlead's validator wants this key present on every step, `null` for a new
   * one. Omitting it entirely is rejected on some accounts, which reads as a
   * malformed-body error with no mention of the missing field.
   */
  id: null;
  /** 1-based and contiguous. Gaps are rejected. */
  seq_number: number;
  seq_delay_details: { delay_in_days: number };
  /** Present only on single-variant steps. See note 3 in the header. */
  subject?: string;
  email_body?: string;
  /** Present only on A/B steps. Distributions must sum to 100. */
  seq_variants?: SequenceVariantPayload[];
};

/**
 * One variant's copy, as the page previews it under an expanded step.
 *
 * `variantId` travels so the preview's Edit button can write back through the
 * same saveVariant() the Templates page uses — the copy has exactly one home,
 * and editing it here is editing the template, not a copy of it.
 */
export type SequencePreview = {
  variantId: string;
  slot: string;
  subject: string;
  body: string;
};

export type SequencePlanRow = {
  /**
   * The builder row this step came from, or null when the plan was derived from
   * send_day. Null is what the page reads to know the builder is untouched, and
   * it is the id every edit intent addresses.
   */
  stepId: string | null;
  templateId: string;
  name: string;
  sendDay: number;
  /** Wait before this step, in days, relative to the previous one. */
  delayDays: number;
  /** Running total of the delays up to and including this step, for "Day N". */
  dayOffset: number;
  seqNumber: number;
  variantCount: number;
  /** Slot letters actually uploaded, e.g. ["A", "B"]. */
  slots: string[];
  /** The step's pinned slot, or null for "every variant with copy" (an A/B split). */
  variantSlot: string | null;
  /** Every slot on the template that has copy — the options a pin can choose from. */
  usableSlots: string[];
  /** Subject and body of each uploaded variant, for the expandable preview. */
  preview: SequencePreview[];
};

export type SequencePlan = {
  steps: SequenceStep[];
  included: SequencePlanRow[];
  skipped: { templateId: string; name: string; reason: string }[];
  /**
   * Blocking reasons the push must not run. Non-empty means the button is
   * disabled AND the server refuses — both read this same function, so the
   * preview can never disagree with what the action will do.
   */
  problems: string[];
  /**
   * Non-blocking notes. Kept apart from `problems` because these describe what
   * the numbers will do afterwards, not whether the upload is safe — a sequence
   * that sends the same copy twice is a legitimate thing to build, it just can't
   * have its statistics attributed. Blocking it would forbid the arrangement to
   * protect a counter.
   */
  warnings: string[];
  /** Total days the sequence spans, i.e. the last step's dayOffset. */
  totalDays: number;
};

/**
 * One row of the builder, as stored in `smartlead_sequence_steps` and passed
 * back in here. See migration 0012 for why this is stored at all.
 */
export type StoredSequenceStep = {
  id: string;
  templateId: string;
  /** null = every variant with copy (an A/B split); "A" | "B" = pinned to one. */
  variantSlot: string | null;
  /** Wait before this step, relative to the previous one. */
  delayDays: number;
};

/**
 * Steps one push will send. Well above any real sequence; this exists so a
 * runaway template list fails loudly instead of rewriting a campaign into
 * something nobody intended.
 */
export const MAX_SEQUENCE_STEPS = 30;

/**
 * Escape plain text into an HTML email body.
 *
 * CRM template bodies are plain text — app/crm/templates-page.tsx renders them
 * into a textarea and app/lib/validate.ts stores them verbatim. Smartlead's
 * `email_body` is HTML, so this is the "point of use" that validate.ts's
 * validateVariantContent comment anticipated: the escaping belongs here, at the
 * boundary where the text first becomes markup, and not in storage where it would
 * corrupt what the author sees in the editor.
 *
 * Merge tokens ({{first_name}}, {{company}}, {{sender}}) pass through untouched.
 * That is deliberate and safe: `{`, `}` and `_` have no meaning in HTML, and
 * Smartlead uses the very same {{token}} syntax — so copy written for the CRM
 * personalises correctly in Smartlead with no rewriting.
 */
export function toHtmlBody(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Blank-line-separated blocks become paragraphs; single newlines inside a block
  // become <br>. Matches how the text reads in the CRM's own textarea.
  const paragraphs = escaped
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${block.replace(/\r?\n/g, "<br>")}</p>`);
  return paragraphs.join("");
}

/** A variant is worth uploading if it has any copy at all. */
function isUsable(v: { subject: string; body: string }): boolean {
  return Boolean(v.subject.trim() || v.body.trim());
}

/**
 * Turn one loop's sequence into the payload for POST /campaigns/{id}/sequences,
 * plus a human-readable account of what went in and what didn't.
 *
 * TWO MODES, one output. Pass `stored` (the loop's rows from the sequence
 * builder) and the plan is exactly those steps in exactly that order. Omit it,
 * or pass an empty list, and the plan is DERIVED as it always was — which is what
 * a loop nobody has opened the builder on still does, so the feature is an
 * override rather than a replacement. See migration 0012.
 *
 * Derived inclusion rule: the template is on this loop and its status is not
 * 'concluded'. Draft *and* running both go — a first upload is necessarily all
 * drafts, and refusing them would make the button do nothing on day one, while
 * 'concluded' means the test is over and the copy has been retired. The page
 * lists `included` and `skipped` before the button is armed, so nothing about
 * this is a surprise at the moment it fires. Builder mode applies no such filter:
 * a step someone put in the sequence on purpose is in the sequence, concluded or
 * not, because that is what they said.
 *
 * Derived ordering: ascending sendDay, ties broken by name then id. The tiebreak
 * matters — `created_at` has second resolution, so two templates made in the same
 * second would otherwise swap places between one render and the next, and
 * seq_number is how stats are attributed back. Builder mode orders by `position`,
 * which the caller has already applied.
 *
 * Either way the stats sync replays THIS function over the same inputs to map a
 * `sequence_number` back to a template, so there is still no template->step table
 * — only the authored order is stored, never the numbering derived from it.
 */
export function buildSequencePlan(
  templates: EmailTemplate[],
  loop: number,
  stored?: StoredSequenceStep[],
): SequencePlan {
  return stored && stored.length
    ? assemble(draftsFromSteps(templates, stored), false)
    : assemble(draftsFromSendDay(templates, loop), true);
}

/**
 * One step before inclusion is decided: which template, which variant, how long
 * to wait. Both modes produce these, and `assemble` turns them into the payload.
 */
type StepDraft = {
  stepId: string | null;
  template: EmailTemplate | null;
  /** Only set when `template` is null — a builder row pointing at a deleted one. */
  missingTemplateId?: string;
  variantSlot: string | null;
  /** Ignored in derived mode, where the wait comes from the send_day gap. */
  delayDays: number;
};

/** Derived mode: every non-concluded template on the loop, ordered by send_day. */
function draftsFromSendDay(templates: EmailTemplate[], loop: number): StepDraft[] {
  return templates
    .filter((t) => t.loop === loop && t.status !== "concluded")
    .sort(
      (a, b) =>
        a.sendDay - b.sendDay || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    )
    .map((template) => ({
      stepId: null,
      template,
      variantSlot: null,
      delayDays: 0,
    }));
}

/**
 * Builder mode: exactly the stored rows, in their stored order.
 *
 * A row whose template has been deleted is kept as a draft with no template
 * rather than filtered out, so `assemble` can report it as a skipped step. A
 * builder that quietly loses a row is how someone uploads a three-step sequence
 * believing it has four.
 *
 * Nothing in the app can currently produce that row — D1 enforces the reference
 * and deleteTemplate() drops the steps in the same batch — so this branch is
 * defensive: it costs three lines and it is the difference between a bad row
 * being visible and a sequence being quietly one step short.
 */
function draftsFromSteps(
  templates: EmailTemplate[],
  stored: StoredSequenceStep[],
): StepDraft[] {
  const byId = new Map(templates.map((t) => [t.id, t] as const));
  return stored.map((step) => {
    const template = byId.get(step.templateId) ?? null;
    return {
      stepId: step.id,
      template,
      ...(template ? {} : { missingTemplateId: step.templateId }),
      variantSlot: step.variantSlot,
      delayDays: step.delayDays,
    };
  });
}

/**
 * Turn drafts into the Smartlead payload plus the account of what went in.
 *
 * `deriveDelay` is the one behavioural difference between the two modes: derived
 * plans compute each wait from the send_day gap, builder plans use the wait that
 * was authored. Everything else — the skip rules, the flatten-vs-split shape, the
 * blocking checks — is shared, which is what stops the two modes drifting into
 * disagreeing about what a valid sequence is.
 */
function assemble(drafts: StepDraft[], deriveDelay: boolean): SequencePlan {
  const steps: SequenceStep[] = [];
  const included: SequencePlanRow[] = [];
  const skipped: SequencePlan["skipped"] = [];

  // Tracks the send day of the last INCLUDED step, so a skipped template in the
  // middle doesn't swallow its own gap. If day 0 and day 7 survive but day 3 is
  // skipped for having no copy, the delay to day 7 must be 7, not 4.
  let previousSendDay = 0;
  let dayOffset = 0;

  for (const draft of drafts) {
    const template = draft.template;
    if (!template) {
      skipped.push({
        templateId: draft.missingTemplateId ?? "",
        name: "Deleted template",
        reason: "the template it pointed at no longer exists",
      });
      continue;
    }

    const usable = template.variants.filter(isUsable);
    if (!usable.length) {
      skipped.push({
        templateId: template.id,
        name: template.name,
        reason: "no subject or body written yet",
      });
      continue;
    }

    // A pinned slot narrows the upload to that one variant. Pinning to a slot
    // that has since been emptied is reported rather than silently widened back
    // to the whole template: the step was authored to send B, and sending A
    // instead is a different email going to real people.
    const chosen = draft.variantSlot
      ? usable.filter((v) => v.slot === draft.variantSlot)
      : usable;
    if (!chosen.length) {
      skipped.push({
        templateId: template.id,
        name: template.name,
        reason: `variant ${draft.variantSlot} has no subject or body written yet`,
      });
      continue;
    }

    const seqNumber = steps.length + 1;
    // First step always waits zero: Smartlead starts the sequence when the lead
    // enters it, so a delay on step 1 would postpone the whole campaign.
    const delayDays =
      seqNumber === 1
        ? 0
        : deriveDelay
          ? Math.max(0, template.sendDay - previousSendDay)
          : Math.max(0, draft.delayDays);

    const step: SequenceStep = {
      id: null,
      seq_number: seqNumber,
      seq_delay_details: { delay_in_days: delayDays },
    };

    if (chosen.length === 1) {
      // Flattened — see note 3 in the header.
      step.subject = chosen[0].subject;
      step.email_body = toHtmlBody(chosen[0].body);
    } else {
      // Distributions must sum to exactly 100. Computing the last slot as the
      // remainder rather than giving every slot `100 / n` is what keeps that true
      // for counts that don't divide evenly; today VARIANT_SLOTS caps this at two,
      // but the arithmetic shouldn't be the thing that breaks when a third is added.
      const even = Math.floor(100 / chosen.length);
      step.seq_variants = chosen.map((v, i) => ({
        [SEQ_VARIANT_KEYS.id]: v.slot,
        [SEQ_VARIANT_KEYS.subject]: v.subject,
        [SEQ_VARIANT_KEYS.body]: toHtmlBody(v.body),
        [SEQ_VARIANT_KEYS.distribution]:
          i === chosen.length - 1 ? 100 - even * (chosen.length - 1) : even,
      }));
    }

    dayOffset += delayDays;
    steps.push(step);
    included.push({
      stepId: draft.stepId,
      templateId: template.id,
      name: template.name,
      sendDay: template.sendDay,
      delayDays,
      dayOffset,
      seqNumber,
      variantCount: chosen.length,
      slots: chosen.map((v) => v.slot),
      variantSlot: draft.variantSlot,
      usableSlots: usable.map((v) => v.slot),
      preview: chosen.map((v) => ({
        variantId: v.id,
        slot: v.slot,
        subject: v.subject,
        body: v.body,
      })),
    });
    previousSendDay = template.sendDay;
  }

  // Blocking checks, deliberately here rather than in the route: the page's
  // preview and the action's guard then read the same answer, so a disabled
  // button and a refused POST can never disagree.
  const problems: string[] = [];
  if (!steps.length) {
    // The critical one. POST /sequences REPLACES the whole sequence, so an empty
    // payload doesn't "do nothing" — it wipes a live campaign's copy, and the
    // campaign keeps running with nothing to send.
    problems.push(
      skipped.length
        ? "Nothing to upload: every step on this loop is missing its copy. Uploading now would erase the campaign's existing steps."
        : "Nothing to upload: this loop has no steps. Uploading now would erase the campaign's existing steps.",
    );
  }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    problems.push(
      `${steps.length} steps is more than the ${MAX_SEQUENCE_STEPS} this will upload in one go.`,
    );
  }

  return {
    steps,
    included,
    skipped,
    problems,
    warnings: duplicateWarnings(included),
    totalDays: dayOffset,
  };
}

/**
 * The key a stats sync attributes a step's numbers to.
 *
 * Null for a step that can't be attributed at all (an A/B split, whose rows carry
 * no variant id), which is the pre-existing "skipped by name" case.
 */
export function statKey(row: SequencePlanRow): string | null {
  return row.variantCount === 1 ? `${row.templateId}/${row.slots[0]}` : null;
}

/**
 * (template, variant) pairs appearing in more than one step.
 *
 * Worth naming because the counters are ABSOLUTE totals, not increments: two
 * steps writing the same variant means the second write replaces the first and
 * the template's numbers report one step's performance as if it were the whole
 * thing. The sync skips these pairs; the page says so up front, since the point
 * of the warning is to be read before the sequence is built that way.
 */
export function duplicateStatKeys(rows: SequencePlanRow[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = statKey(row);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}

function duplicateWarnings(rows: SequencePlanRow[]): string[] {
  const duplicates = duplicateStatKeys(rows);
  if (!duplicates.size) return [];
  const names = rows
    .filter((row) => {
      const key = statKey(row);
      return key !== null && duplicates.has(key);
    })
    .map((row) => `${row.name} · ${row.slots[0]}`);
  return [
    `${[...new Set(names)].join(", ")} appears more than once. The sequence uploads fine, but a stats sync can't tell those steps apart, so it will leave that template's numbers alone.`,
  ];
}

// ---------------------------------------------------------------------------
// Senders (Smartlead email accounts -> the mailboxes a campaign sends from)
// ---------------------------------------------------------------------------
//
// A campaign sends from one or more of the account's connected mailboxes, and
// rotates between them. Nothing about them is stored in D1: unlike the sequence,
// which this CRM authors, the mailbox list is Smartlead's own state — read on
// demand, changed by assigning or unassigning, and never mirrored here, so there
// is nothing that can drift out of date while nobody is looking.

/**
 * One email account as Smartlead returns it, from either
 * `/email-accounts/` or `/campaigns/{id}/email-accounts`.
 *
 * Every field is optional because both endpoints have shipped rows missing one:
 * the two warmup fields in particular arrive flat on some accounts and nested
 * under `warmup_details` on others, so both spellings are read below rather than
 * assumed. Nothing else on the row is mapped — a mailbox's password, SMTP host
 * and port are on it too, and none of that belongs anywhere near this CRM.
 */
export type SmartleadEmailAccount = {
  id?: number | string | null;
  from_email?: string | null;
  from_name?: string | null;
  type?: string | null;
  warmup_enabled?: boolean | null;
  warmup_reputation?: number | string | null;
  warmup_details?: {
    status?: string | null;
    warmup_reputation?: number | string | null;
  } | null;
};

/** One mailbox, as the page renders it. */
export type SmartleadSender = {
  accountId: string;
  fromEmail: string;
  fromName: string;
  /** Smartlead's `type` — GMAIL, OUTLOOK, SMTP. Shown verbatim, or "" when absent. */
  provider: string;
  warmupEnabled: boolean;
  /**
   * Warmup reputation exactly as Smartlead reports it ("100%", "94"), or null
   * when the row carries none. Deliberately kept as text and rendered verbatim:
   * this CRM measures nothing about deliverability, so translating the number
   * into a word of our own would be putting our label on their figure.
   */
  warmupReputation: string | null;
  /** The same value read as a percentage, or null when it isn't one. Colours the dot. */
  warmupPercent: number | null;
};

function accountText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function reputationText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Shape one row, or null when it carries no id — there is nothing to assign or remove. */
export function mapEmailAccount(row: SmartleadEmailAccount): SmartleadSender | null {
  const accountId = row?.id === undefined || row?.id === null ? "" : String(row.id).trim();
  if (!accountId) return null;

  const details = row.warmup_details ?? null;
  const warmupReputation =
    reputationText(row.warmup_reputation) ?? reputationText(details?.warmup_reputation);
  // Flat flag first, then a warmup_details block reporting ACTIVE. A row with
  // neither reads as false, which is an absence and not a statement — so the page
  // only says "off" where there is a reputation figure for it to contradict,
  // rather than announcing a setting the response never mentioned.
  const warmupEnabled =
    typeof row.warmup_enabled === "boolean"
      ? row.warmup_enabled
      : accountText(details?.status).toUpperCase() === "ACTIVE";

  const percent = warmupReputation === null ? NaN : Number(warmupReputation.replace("%", "").trim());

  return {
    accountId,
    fromEmail: accountText(row.from_email),
    fromName: accountText(row.from_name),
    provider: accountText(row.type),
    warmupEnabled,
    warmupReputation,
    warmupPercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
  };
}

/** How healthy a mailbox's warmup looks. See warmupTone(). */
export type WarmupTone = "strong" | "fair" | "weak" | "unknown";

/**
 * Which band the dot beside a mailbox falls in.
 *
 * The thresholds are OURS. Smartlead publishes a percentage and no grades, so
 * there is no scale to copy — which is exactly why the percentage itself is
 * always rendered next to the dot, and why an unparseable value is "unknown"
 * rather than assumed bad. Read the number, not the colour.
 */
export function warmupTone(sender: SmartleadSender): WarmupTone {
  if (sender.warmupPercent === null) return "unknown";
  if (sender.warmupPercent >= 90) return "strong";
  if (sender.warmupPercent >= 75) return "fair";
  return "weak";
}

export type SenderPlan = {
  /** Mailboxes this campaign currently sends from. */
  assigned: SmartleadSender[];
  /** On the account but not on this campaign — the ones "Assign" can add. */
  available: SmartleadSender[];
};

/**
 * Split the account's mailboxes into the campaign's and the rest.
 *
 * Membership is decided by the campaign's OWN list, never by re-deriving it from
 * a flag on the account-wide rows: a mailbox can serve several campaigns at once,
 * so nothing on the account row says which ones. Assigned entries are taken from
 * the campaign response, so a mailbox the account-wide read didn't reach (it is
 * paged, and the cap is a real one) still appears as assigned rather than
 * silently dropping out of the rotation the page is describing.
 */
export function planSenders(
  assignedRows: SmartleadEmailAccount[],
  accountRows: SmartleadEmailAccount[],
): SenderPlan {
  const assigned = new Map<string, SmartleadSender>();
  for (const row of assignedRows) {
    const sender = mapEmailAccount(row);
    if (sender) assigned.set(sender.accountId, sender);
  }

  const available = new Map<string, SmartleadSender>();
  for (const row of accountRows) {
    const sender = mapEmailAccount(row);
    if (!sender || assigned.has(sender.accountId)) continue;
    available.set(sender.accountId, sender);
  }

  return {
    assigned: [...assigned.values()].sort(byAddress),
    available: [...available.values()].sort(byAddress),
  };
}

/** Address order, so the two lists don't reshuffle between reads. */
function byAddress(a: SmartleadSender, b: SmartleadSender): number {
  return (
    a.fromEmail.localeCompare(b.fromEmail) || a.accountId.localeCompare(b.accountId)
  );
}

// ---------------------------------------------------------------------------
// Leads (CRM contacts <-> Smartlead leads)
// ---------------------------------------------------------------------------

export type SmartleadLeadPayload = {
  email: string;
  first_name: string;
  last_name: string;
  company_name: string;
  phone_number?: string;
  linkedin_profile?: string;
  custom_fields: Record<string, string>;
};

export type LeadPlan = {
  leads: SmartleadLeadPayload[];
  /** Contact ids, index-aligned with `leads`, for recording the push. */
  contactIds: string[];
  alreadyPushed: number;
  noEmail: number;
  /** In this loop but already sequencing in the other loop's campaign. */
  inOtherCampaign: number;
  /** Excluded by pipeline status, counted per status so the page can say which. */
  wrongStatus: Record<string, number>;
  /** Eligible-for-this-loop total, before any exclusion. */
  onLoop: number;
};

/**
 * Statuses a contact may be cold-emailed in.
 *
 * The four excluded statuses are each a distinct way of embarrassing the sender:
 * `Replied` and `Meeting booked` mean a human conversation is already open (and
 * Smartlead stops sequencing on reply anyway, so the lead would be added only to
 * be stopped); `Won` cold-emails a customer; `Dead` emails someone who has
 * already said no — which, for an unsubscribe, is the difference between a bug
 * and a legal problem.
 */
export const PUSHABLE_STATUSES: ReadonlySet<string> = new Set(["New", "Contacted"]);

/**
 * Split a display name into the two fields Smartlead personalises on.
 *
 * On the first space only: "Mary Anne van der Berg" is first "Mary", last
 * "Anne van der Berg". Wrong for some names, but {{first_name}} is what appears
 * in a subject line, and over-splitting there ("Hi Mary Anne van der") reads far
 * worse than under-splitting the surname, which is rarely rendered at all.
 */
function splitName(name: string): { first: string; last: string } {
  const trimmed = name.trim();
  const space = trimmed.indexOf(" ");
  if (space === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, space), last: trimmed.slice(space + 1).trim() };
}

/**
 * Decide which contacts to hand to a campaign, and shape them as leads.
 *
 * `alreadyPushedIds` is the set already recorded against this campaign, so a
 * second click pushes only what's new rather than relying on Smartlead's own
 * duplicate handling (which is account-wide and would also suppress a legitimate
 * re-add after a removal).
 *
 * `otherCampaignIds` is the set sequencing in the OTHER loop's campaign, and
 * excluding it fixes a real double-send. A contact's `loops` is not exclusive:
 * resumeToLoop1() in app/lib/crm.server.ts adds Loop 1 while deliberately keeping
 * Loop 2 for provenance, so every resumed contact is in both. With one campaign
 * per loop and no guard here, that contact receives two cold sequences at once,
 * from two mailboxes, and neither campaign knows about the other.
 *
 * The CRM id travels in `custom_fields.crm_id`. Nothing reads it back today — the
 * smartlead_leads table is the authoritative link — but it is what makes a lead
 * traceable to a contact from inside Smartlead's own UI, which is where someone
 * debugging a bad send will be standing.
 */
export function planLeads(
  contacts: Contact[],
  loop: number,
  alreadyPushedIds: ReadonlySet<string>,
  otherCampaignIds: ReadonlySet<string> = new Set(),
): LeadPlan {
  const onLoopContacts = contacts.filter((c) => c.loops.includes(loop));

  const leads: SmartleadLeadPayload[] = [];
  const contactIds: string[] = [];
  const wrongStatus: Record<string, number> = {};
  let alreadyPushed = 0;
  let noEmail = 0;
  let inOtherCampaign = 0;

  for (const contact of onLoopContacts) {
    if (alreadyPushedIds.has(contact.id)) {
      alreadyPushed++;
      continue;
    }
    if (otherCampaignIds.has(contact.id)) {
      inOtherCampaign++;
      continue;
    }
    if (!PUSHABLE_STATUSES.has(contact.status)) {
      wrongStatus[contact.status] = (wrongStatus[contact.status] ?? 0) + 1;
      continue;
    }
    const email = (contact.email ?? "").trim();
    if (!email) {
      noEmail++;
      continue;
    }

    const { first, last } = splitName(contact.name);
    const custom: Record<string, string> = {
      crm_id: contact.id,
      crm_loop: contact.loops.join(","),
    };
    if (contact.source) custom.crm_source = contact.source;
    if (contact.owner) custom.crm_owner = contact.owner;

    const lead: SmartleadLeadPayload = {
      email,
      first_name: first,
      last_name: last,
      company_name: contact.company ?? "",
      custom_fields: custom,
    };
    // Omitted rather than sent empty: Smartlead stores what it is given, and a
    // blank string overwrites a value already on an existing lead.
    if (contact.phone) lead.phone_number = contact.phone;
    if (contact.linkedin) lead.linkedin_profile = contact.linkedin;

    leads.push(lead);
    contactIds.push(contact.id);
  }

  return {
    leads,
    contactIds,
    alreadyPushed,
    noEmail,
    inOtherCampaign,
    wrongStatus,
    onLoop: onLoopContacts.length,
  };
}

/** One lead as GET /campaigns/{id}/leads returns it. Every field is optional in practice. */
export type SmartleadLead = {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  phone_number?: string | null;
  linkedin_profile?: string | null;
};

/** A row shaped for validateImportRows() — the same shape the CSV importer builds. */
export type ImportRow = {
  name: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
  loops: number[];
  status: string;
  source: string | null;
};

export type ImportPlan = {
  rows: ImportRow[];
  duplicates: number;
  noEmail: number;
  total: number;
};

/**
 * Shape inbound Smartlead leads as CRM contacts.
 *
 * The result is handed to the EXISTING validateImportRows() + createManyContacts()
 * in the route, so a Smartlead lead passes through byte-for-byte the same
 * validation as a row of pasted CSV. This function only maps and dedupes; it
 * deliberately does not bound or whitelist anything, because doing so here would
 * be a second opinion about what a valid contact is.
 *
 * `existingEmails` must be lowercased by the caller — it holds both the CRM's own
 * contact addresses and everything already pushed to this campaign, so a
 * round-trip (push contacts out, import the campaign back) creates nothing.
 *
 * `owner` is left unset rather than guessed: Smartlead has no concept of a CRM
 * owner, and an imported lead assigned to the wrong person escapes that person's
 * queue silently. It arrives unassigned, which the contacts page already surfaces.
 */
export function planImport(
  leads: SmartleadLead[],
  existingEmails: ReadonlySet<string>,
  loop: number,
  sourceLabel: string,
): ImportPlan {
  const rows: ImportRow[] = [];
  // Seeded from the caller's set and added to as we go, so duplicates *within*
  // one response are caught too.
  const seen = new Set(existingEmails);
  let duplicates = 0;
  let noEmail = 0;

  for (const lead of leads) {
    const email = (lead.email ?? "").trim();
    if (!email) {
      noEmail++;
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);

    const name = [lead.first_name ?? "", lead.last_name ?? ""]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");

    rows.push({
      // A lead with no name at all still has an address, and dropping it would
      // lose the only thing outreach actually needs. validateContact requires a
      // name, so the address stands in for one.
      name: name || email,
      company: (lead.company_name ?? "").trim(),
      email,
      phone: (lead.phone_number ?? "").trim(),
      linkedin: (lead.linkedin_profile ?? "").trim(),
      loops: [loop],
      status: "Contacted",
      // Loop 2 contacts carry the community they came from; the campaign name is
      // the closest true answer for a lead that arrived through Smartlead.
      source: loop === 2 ? sourceLabel : null,
    });
  }

  return { rows, duplicates, noEmail, total: leads.length };
}

// ---------------------------------------------------------------------------
// Statistics (Smartlead per-email rows -> CRM variant counters)
// ---------------------------------------------------------------------------

/** One row of GET /campaigns/{id}/statistics. */
export type SmartleadStatRow = {
  sequence_number?: number | string | null;
  // The address the email went to. Unused by the totals below, which aggregate
  // across leads, and load-bearing for sendsByLead() further down, which does
  // the opposite. Read through statEmail() rather than directly — the field is
  // spelled differently on the neighbouring /leads endpoint.
  lead_email?: string | null;
  sent_time?: string | null;
  open_time?: string | null;
  reply_time?: string | null;
};

export type StepTotals = { sends: number; opens: number; replies: number };

/**
 * Total per-email statistics rows by sequence number.
 *
 * A row counts as a send when it has a `sent_time`; opens and replies likewise
 * key off the presence of their timestamp rather than a separate count column, so
 * one email that was opened five times still counts once. That matches what the
 * CRM's own `opens` means in app/crm/ab.ts, where the reply *rate* is the figure
 * the z-test runs on.
 *
 * Rows carry no variant identifier, which is the reason the caller can only
 * attribute these to a template's default variant — see the sync intent.
 */
export function totalStatsBySequence(rows: SmartleadStatRow[]): Map<number, StepTotals> {
  const bySeq = new Map<number, StepTotals>();
  for (const row of rows) {
    const seq = Number(row.sequence_number);
    if (!Number.isInteger(seq) || seq < 1) continue;
    const totals = bySeq.get(seq) ?? { sends: 0, opens: 0, replies: 0 };
    if (row.sent_time) totals.sends++;
    if (row.open_time) totals.opens++;
    if (row.reply_time) totals.replies++;
    bySeq.set(seq, totals);
  }
  return bySeq;
}

// ---------------------------------------------------------------------------
// Sends (Smartlead per-email rows -> CRM contacts)
// ---------------------------------------------------------------------------
//
// The other direction of the same /statistics read that feeds the counters
// above. Those rows are totalled by sequence step to score a TEMPLATE; here the
// identical rows are grouped by address to answer a question about a PERSON —
// has this contact actually been emailed, and when.
//
// Pushing a lead is not sending it. planLeads() above hands a contact to a
// campaign; Smartlead then sends on its own schedule, paced by
// max_new_leads_per_day, and a paused campaign or a suppressed address means
// some pushed leads are never emailed at all. `sent_time` is the only fact that
// says an email left, so it is the only thing these functions treat as one.

/**
 * Statuses a send is allowed to move a contact OUT of.
 *
 * Only "New". Every other status is either further along the pipeline than
 * "Contacted" (Replied, Meeting booked, Won) or a deliberate end (Dead), and a
 * step-three send arriving after someone replied must not walk the contact
 * backwards over a human's judgement. The set is the mirror image of
 * PUSHABLE_STATUSES: that one says who may be emailed, this one says whose
 * status an email may still change.
 */
export const SENT_PROMOTES_FROM: ReadonlySet<string> = new Set(["New"]);

/** The status a contact reaches once a campaign has emailed it. */
export const SENT_STATUS = "Contacted";

/** One email Smartlead reports having sent to one lead. */
export type LeadSend = {
  /** Stable identity of this send within the lead — see migration 0015. */
  key: string;
  /** The sequence step it came from, or null when the row does not say. */
  seqNumber: number | null;
  /** `sent_time` verbatim. */
  sentAt: string;
};

/**
 * The address a statistics row is about.
 *
 * Smartlead names this field `lead_email` on /statistics, but the same account's
 * /leads rows call it `email` and arrive wrapped as `{ lead: {...} }` — which is
 * why unwrapLead() exists in the route. Rather than assume statistics never
 * wraps, this reads both shapes and all three spellings, and returns "" when
 * none of them holds a string. An empty result skips the row: attributing a send
 * to the wrong person is worse than not recording it.
 */
export function statEmail(row: SmartleadStatRow): string {
  const obj = (row ?? {}) as Record<string, unknown>;
  const nested = (obj.lead ?? {}) as Record<string, unknown>;
  for (const source of [obj, nested]) {
    for (const field of ["lead_email", "to_email", "email"]) {
      const value = source[field];
      if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
  }
  return "";
}

/**
 * Group statistics rows into the sends made to each address, oldest first.
 *
 * Rows without a `sent_time` are dropped — those are queued or skipped emails,
 * and this whole path exists to distinguish them from ones that went out. Rows
 * are deduped by key within a lead, so the same step appearing twice across two
 * pages counts once.
 *
 * Sorting is by the `sent_time` string rather than a parsed date: these are ISO
 * timestamps from one source, so they sort correctly as text, and no Date is
 * constructed in a module that must stay pure (see the header of this file).
 */
export function sendsByLead(rows: SmartleadStatRow[]): Map<string, LeadSend[]> {
  const byEmail = new Map<string, Map<string, LeadSend>>();

  for (const row of rows) {
    const sentAt = typeof row.sent_time === "string" ? row.sent_time.trim() : "";
    if (!sentAt) continue;
    const email = statEmail(row);
    if (!email) continue;

    const seq = Number(row.sequence_number);
    const seqNumber = Number.isInteger(seq) && seq >= 1 ? seq : null;
    // A row with no usable step number still describes a real send, so it is
    // keyed on its timestamp instead of dropped. Two sends to one lead at the
    // identical instant would collapse into one; a duplicate row is the far
    // likelier explanation of that than two simultaneous emails.
    const key = seqNumber === null ? `t:${sentAt}` : `s:${seqNumber}`;

    let sends = byEmail.get(email);
    if (!sends) {
      sends = new Map<string, LeadSend>();
      byEmail.set(email, sends);
    }
    if (!sends.has(key)) sends.set(key, { key, seqNumber, sentAt });
  }

  const out = new Map<string, LeadSend[]>();
  for (const [email, sends] of byEmail) {
    out.set(
      email,
      [...sends.values()].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0)),
    );
  }
  return out;
}

/** A campaign's lead link joined to the contact it points at. */
export type StoredLeadState = {
  contactId: string;
  /** The address as it was pushed, lowercased by the reader. */
  email: string;
  status: string;
  owner: string | null;
  /** The contact's primary (lowest) loop, for the touchpoint row. */
  loop: number;
  /** Send keys already written as touchpoints for this lead. */
  loggedKeys: string[];
};

export type ContactSendUpdate = {
  contactId: string;
  owner: string | null;
  loop: number;
  /** Sends seen for the first time — one touchpoint each. */
  newSends: LeadSend[];
  /** Every key now known for this lead, for the emailed_steps column. */
  allKeys: string[];
  /** Newest `sent_time` observed, for last_emailed_at. */
  lastSentAt: string;
  /** True when this contact is still "New" and the send moves it to Contacted. */
  markContacted: boolean;
};

/**
 * Work out what each lead's observed sends change about its contact.
 *
 * A lead with nothing new produces no update at all, which is what makes
 * pressing Sync twice a no-op rather than a second timeline entry: the keys
 * already stored are subtracted before anything is proposed.
 *
 * `markContacted` is deliberately gated on there being a NEW send. A contact
 * someone has manually set back to "New" after the sends were already logged is
 * left alone — the operator is saying something about the contact, and this
 * function has no newer fact to answer with.
 */
export function planContactSends(
  leads: StoredLeadState[],
  sends: Map<string, LeadSend[]>,
): ContactSendUpdate[] {
  const updates: ContactSendUpdate[] = [];

  for (const lead of leads) {
    const observed = sends.get(lead.email.trim().toLowerCase());
    if (!observed?.length) continue;

    const known = new Set(lead.loggedKeys);
    const newSends = observed.filter((send) => !known.has(send.key));
    if (!newSends.length) continue;
    for (const send of newSends) known.add(send.key);

    updates.push({
      contactId: lead.contactId,
      owner: lead.owner,
      loop: lead.loop,
      newSends,
      allKeys: [...known],
      lastSentAt: observed[observed.length - 1].sentAt,
      markContacted: SENT_PROMOTES_FROM.has(lead.status),
    });
  }

  return updates;
}
