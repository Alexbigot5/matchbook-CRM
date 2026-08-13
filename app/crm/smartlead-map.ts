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

export type SequencePlanRow = {
  templateId: string;
  name: string;
  sendDay: number;
  /** Wait before this step, in days, relative to the previous one. */
  delayDays: number;
  seqNumber: number;
  variantCount: number;
  /** Slot letters actually uploaded, e.g. ["A", "B"]. */
  slots: string[];
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
 * Turn one loop's templates into the payload for
 * POST /campaigns/{id}/sequences, plus a human-readable account of what went in
 * and what didn't.
 *
 * Inclusion rule: the template is on this loop and its status is not
 * 'concluded'. Draft *and* running both go — a first upload is necessarily all
 * drafts, and refusing them would make the button do nothing on day one, while
 * 'concluded' means the test is over and the copy has been retired. The page
 * lists `included` and `skipped` before the button is armed, so nothing about
 * this is a surprise at the moment it fires.
 *
 * Ordering: ascending sendDay, ties broken by name then id. The tiebreak matters
 * — `created_at` has second resolution, so two templates made in the same second
 * would otherwise swap places between one render and the next, and seq_number is
 * how stats are attributed back. The same ordering is replayed by the stats sync
 * to map a `sequence_number` back to a template, which is why no template->step
 * table is stored.
 */
export function buildSequencePlan(templates: EmailTemplate[], loop: number): SequencePlan {
  const eligible = templates
    .filter((t) => t.loop === loop && t.status !== "concluded")
    .sort(
      (a, b) =>
        a.sendDay - b.sendDay || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );

  const steps: SequenceStep[] = [];
  const included: SequencePlanRow[] = [];
  const skipped: SequencePlan["skipped"] = [];

  // Tracks the send day of the last INCLUDED step, so a skipped template in the
  // middle doesn't swallow its own gap. If day 0 and day 7 survive but day 3 is
  // skipped for having no copy, the delay to day 7 must be 7, not 4.
  let previousSendDay = 0;

  for (const template of eligible) {
    const usable = template.variants.filter(isUsable);
    if (!usable.length) {
      skipped.push({
        templateId: template.id,
        name: template.name,
        reason: "no subject or body written yet",
      });
      continue;
    }

    const seqNumber = steps.length + 1;
    // First step always waits zero: Smartlead starts the sequence when the lead
    // enters it, so a delay on step 1 would postpone the whole campaign.
    const delayDays = seqNumber === 1 ? 0 : Math.max(0, template.sendDay - previousSendDay);

    const step: SequenceStep = {
      id: null,
      seq_number: seqNumber,
      seq_delay_details: { delay_in_days: delayDays },
    };

    if (usable.length === 1) {
      // Flattened — see note 3 in the header.
      step.subject = usable[0].subject;
      step.email_body = toHtmlBody(usable[0].body);
    } else {
      // Distributions must sum to exactly 100. Computing the last slot as the
      // remainder rather than giving every slot `100 / n` is what keeps that true
      // for counts that don't divide evenly; today VARIANT_SLOTS caps this at two,
      // but the arithmetic shouldn't be the thing that breaks when a third is added.
      const even = Math.floor(100 / usable.length);
      step.seq_variants = usable.map((v, i) => ({
        [SEQ_VARIANT_KEYS.id]: v.slot,
        [SEQ_VARIANT_KEYS.subject]: v.subject,
        [SEQ_VARIANT_KEYS.body]: toHtmlBody(v.body),
        [SEQ_VARIANT_KEYS.distribution]:
          i === usable.length - 1 ? 100 - even * (usable.length - 1) : even,
      }));
    }

    steps.push(step);
    included.push({
      templateId: template.id,
      name: template.name,
      sendDay: template.sendDay,
      delayDays,
      seqNumber,
      variantCount: usable.length,
      slots: usable.map((v) => v.slot),
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
        ? "Nothing to upload — every template on this loop is missing its copy. Uploading now would erase the campaign's existing steps."
        : "Nothing to upload — this loop has no templates. Uploading now would erase the campaign's existing steps.",
    );
  }
  if (steps.length > MAX_SEQUENCE_STEPS) {
    problems.push(
      `${steps.length} steps is more than the ${MAX_SEQUENCE_STEPS} this will upload in one go.`,
    );
  }

  return { steps, included, skipped, problems };
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
