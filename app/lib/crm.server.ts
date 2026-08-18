// Server-only data-access layer for the CRM. Persists to Cloudflare D1 and
// converts the stored absolute timestamps into the relative `daysAgo` /
// `followUp` values that app/crm/data.ts and the UI expect. Keeping every date
// calculation here (against a single `now` captured in the loader) is what keeps
// SSR and client hydration deterministic — no `Date` runs in the render path.

import type { Contact, Note, Touch } from "../crm/data";
import {
  TEMPLATE_STATUSES,
  type EmailTemplate,
  type TemplateStatus,
  type TemplateVariant,
} from "../crm/templates";
import {
  buildSequencePlan,
  MAX_SEQUENCE_STEPS,
  type StoredSequenceStep,
} from "../crm/smartlead-map";
import { parseConditions, type SavedView } from "../crm/views";
import type { DedupedProspect, Prospect, RunCounts } from "../crm/prospecting";
import {
  isValidDedupeReason,
  isValidEmailConfidence,
  isValidProspectStage,
  MAX_SAVED_VIEWS,
  type ProspectStage,
  type SavedViewFields,
  type StatCounts,
  type TemplateFields,
} from "./validate";

const DAY = 86_400_000;

/** UTC midnight of the day containing `ms`. */
function startOfUTCDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole calendar days between two instants (positive if `toMs` is later). */
function dayDiff(fromMs: number, toMs: number): number {
  return Math.floor((startOfUTCDay(toMs) - startOfUTCDay(fromMs)) / DAY);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "Jul 20"-style label, matching the original fmtDate() output. Hand-rolled
 * (no Intl/toLocaleDateString) so it has zero runtime locale/timezone
 * dependency on the Workers runtime.
 */
function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * X-axis labels for the analytics activity chart, computed against the loader's
 * single `now` so no Date runs during render.
 *
 * `dayLabels[0]` is (days - 1) days ago and the last entry is today, which is the
 * exact inverse of the `daysAgo` that listContacts stamps on each touch: both
 * bucket on UTC midnight via dayDiff/startOfUTCDay, so a touch with
 * `daysAgo === k` belongs to `dayLabels[days - 1 - k]`. That alignment is what
 * lets app/crm/analytics.ts bucket the chart without touching a Date — changing
 * either side means changing both.
 */
export function buildAnalyticsLabels(
  now: number,
  days = 14,
): { asOf: string; dayLabels: string[] } {
  const today = startOfUTCDay(now);
  const dayLabels: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayLabels.push(dateLabel(today - i * DAY));
  return { asOf: dateLabel(now), dayLabels };
}

function parseLoops(raw: string): number[] {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const loops = arr.map(Number).filter((n) => n === 1 || n === 2);
      if (loops.length) return loops;
    }
  } catch {
    // fall through to default
  }
  return [1];
}

function normalizeLoops(loops: number[] | undefined): number[] {
  const out = (loops || []).map(Number).filter((n) => n === 1 || n === 2);
  return out.length ? [...new Set(out)].sort() : [1];
}

type ContactRow = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  owner: string | null;
  status: string;
  loops: string;
  source: string | null;
  follow_up_at: string | null;
  resumed_to_loop1_at: string | null;
  dead_reason: string | null;
  created_at: string;
};

type NoteRow = {
  id: string;
  contact_id: string;
  author: string | null;
  text: string;
  created_at: string;
};

type TouchpointRow = {
  id: string;
  contact_id: string;
  type: string | null;
  loop: number | null;
  owner: string | null;
  note: string | null;
  created_at: string;
};

/**
 * Load every contact with its notes and touchpoints, shaped to satisfy the
 * existing `Contact` type. `opts` is always `{}`. `now` is the loader's single
 * reference instant.
 */
export async function listContacts(
  db: D1Database,
  now: number,
  page?: { limit?: number; offset?: number },
): Promise<Contact[]> {
  // Pagination is opt-in and used only by the machine API, which would otherwise
  // return the entire contact book — with notes — in a single response. The app
  // loader passes nothing and still gets everything, because the UI filters and
  // sorts client-side over the full set.
  //
  // Both values are coerced to non-negative integers and bound as parameters;
  // they are never interpolated into the SQL text.
  const limit = page?.limit !== undefined ? Math.max(0, Math.floor(page.limit)) : null;
  const offset = page?.offset !== undefined ? Math.max(0, Math.floor(page.offset)) : 0;

  const [contactsRes, notesRes, touchesRes] = await Promise.all([
    (limit === null
      ? db.prepare(
          "SELECT id, name, company, email, phone, linkedin, owner, status, loops, source, follow_up_at, resumed_to_loop1_at, dead_reason, created_at FROM contacts ORDER BY created_at DESC",
        )
      : db
          .prepare(
            "SELECT id, name, company, email, phone, linkedin, owner, status, loops, source, follow_up_at, resumed_to_loop1_at, dead_reason, created_at FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?",
          )
          .bind(limit, offset)
    ).all<ContactRow>(),
    db
      .prepare(
        "SELECT id, contact_id, author, text, created_at FROM notes ORDER BY created_at DESC",
      )
      .all<NoteRow>(),
    db
      .prepare(
        "SELECT id, contact_id, type, loop, owner, note, created_at FROM touchpoints ORDER BY created_at DESC",
      )
      .all<TouchpointRow>(),
  ]);

  const notesByContact = new Map<string, Note[]>();
  for (const n of notesRes.results ?? []) {
    const list = notesByContact.get(n.contact_id) ?? [];
    list.push({
      author: n.author ?? "",
      text: n.text,
      daysAgo: dayDiff(Date.parse(n.created_at), now),
    });
    notesByContact.set(n.contact_id, list);
  }

  // Touchpoints are ordered newest-first (matching the detail timeline, which
  // reads touches[0] as the most recent). created_at → relative daysAgo here so
  // no Date math runs in the render path.
  const touchesByContact = new Map<string, Touch[]>();
  for (const t of touchesRes.results ?? []) {
    const list = touchesByContact.get(t.contact_id) ?? [];
    list.push({
      owner: t.owner ?? "",
      ch: t.type ?? "email",
      loop: Number(t.loop) || 1,
      daysAgo: dayDiff(Date.parse(t.created_at), now),
      note: t.note ?? "",
    });
    touchesByContact.set(t.contact_id, list);
  }

  return (contactsRes.results ?? []).map((row): Contact => {
    let followUp: number | null = null;
    let followUpDateLabel: string | null = null;
    if (row.follow_up_at) {
      const dueMs = Date.parse(row.follow_up_at);
      followUp = -dayDiff(now, dueMs); // due today -> 0, due in 3 days -> -3
      followUpDateLabel = dateLabel(dueMs);
    }
    const resumedLabel = row.resumed_to_loop1_at
      ? "Resumed to Loop 1 · " + dateLabel(Date.parse(row.resumed_to_loop1_at))
      : null;
    return {
      id: row.id,
      name: row.name,
      company: row.company ?? "",
      email: row.email ?? null,
      phone: row.phone ?? null,
      linkedin: row.linkedin ?? null,
      loops: parseLoops(row.loops),
      owner: row.owner ?? null,
      status: row.status,
      touches: touchesByContact.get(row.id) ?? [],
      notes: notesByContact.get(row.id) ?? [],
      followUp,
      followUpDateLabel,
      source: row.source ?? null,
      resumedToLoop1At: row.resumed_to_loop1_at ?? null,
      resumedLabel,
      deadReason: row.dead_reason ?? null,
      opts: {},
    };
  });
}

export type NewContactInput = {
  name: string;
  company?: string;
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  loops?: number[];
  owner?: string | null;
  status?: string;
  source?: string | null;
};

/**
 * Coerce to a trimmed string. Callers now validate through app/lib/validate.ts,
 * but this layer is reachable with whatever JSON.parse produced, and a bare
 * `.trim()` on a number threw a TypeError rather than rejecting cleanly.
 */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function insertContactStmt(db: D1Database, input: NewContactInput) {
  const name = str(input.name);
  const followUpAt = new Date().toISOString(); // new contacts are "due today"
  const source = str(input.source) || null;
  const email = str(input.email) || null;
  const phone = str(input.phone) || null;
  const linkedin = str(input.linkedin) || null;
  return db
    .prepare(
      "INSERT INTO contacts (id, name, company, email, phone, linkedin, owner, status, loops, source, follow_up_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      name,
      str(input.company),
      email,
      phone,
      linkedin,
      str(input.owner) || null,
      str(input.status) || "New",
      JSON.stringify(normalizeLoops(input.loops)),
      source,
      followUpAt,
    );
}

export async function createContact(db: D1Database, input: NewContactInput): Promise<void> {
  await insertContactStmt(db, input).run();
}

/** Bulk insert (CSV import) in batched, atomic chunks. */
export async function createManyContacts(
  db: D1Database,
  rows: NewContactInput[],
): Promise<number> {
  const valid = rows.filter((r) => r.name && r.name.trim());
  const CHUNK = 50;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK).map((r) => insertContactStmt(db, r));
    if (chunk.length) await db.batch(chunk);
  }
  return valid.length;
}

/**
 * Permanently delete contacts along with everything hanging off them (notes,
 * touchpoints, and Smartlead lead links). Children go first so the FK references
 * stay satisfied, and each chunk is one batched (atomic) write. Returns how many
 * contact rows actually went away — 0 means none of the ids existed.
 *
 * `smartlead_leads` is in that child set for a second reason beyond the dangling
 * FK: those rows are what "this contact is already in the campaign" is read from.
 * Leaving them behind means a contact re-added under a fresh id is fine, but the
 * stale row still counts against the campaign's pushed set forever.
 */
export async function deleteContacts(
  db: D1Database,
  ids: string[],
  actor: string,
): Promise<number> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return 0;

  const CHUNK = 50;
  let deleted = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");

    // Snapshot before the delete. The dataset is shared across all four users and
    // this is a hard delete that takes the contact's notes and touchpoints with
    // it, so without a record there is no way to tell what went missing or who
    // removed it. Read and write in the same batch as the delete so a failure
    // can't leave the log and the table disagreeing.
    const existing = await db
      .prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<ContactRow>();

    const auditRows = (existing.results ?? []).map((row) =>
      db
        .prepare(
          `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, snapshot)
           VALUES (?, ?, 'contact.delete', 'contact', ?, ?)`,
        )
        .bind(crypto.randomUUID(), actor, row.id, JSON.stringify(row)),
    );

    const res = await db.batch([
      ...auditRows,
      db.prepare(`DELETE FROM notes WHERE contact_id IN (${placeholders})`).bind(...chunk),
      db.prepare(`DELETE FROM touchpoints WHERE contact_id IN (${placeholders})`).bind(...chunk),
      db.prepare(`DELETE FROM smartlead_leads WHERE contact_id IN (${placeholders})`).bind(...chunk),
      db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).bind(...chunk),
    ]);
    deleted += res[res.length - 1]?.meta?.changes ?? 0;
  }
  return deleted;
}

/**
 * Set a contact's status, and with it the dead-reason that only makes sense
 * alongside it. `deadReason` is written unconditionally — a contact moving off
 * Dead must lose its reason, or a later re-death with the prompt skipped would
 * silently inherit the old one. Callers pass null for every non-Dead status.
 */
export async function updateContactStatus(
  db: D1Database,
  id: string,
  status: string,
  deadReason: string | null = null,
): Promise<void> {
  await db
    .prepare("UPDATE contacts SET status = ?, dead_reason = ? WHERE id = ?")
    .bind(status, status === "Dead" ? deadReason : null, id)
    .run();
}

/** "Snooze 3d" — mirrors the old followUp = -3. */
export async function snoozeFollowUp(db: D1Database, id: string): Promise<void> {
  const dueAt = new Date(Date.now() + 3 * DAY).toISOString();
  await db
    .prepare("UPDATE contacts SET follow_up_at = ? WHERE id = ?")
    .bind(dueAt, id)
    .run();
}

/** "Mark done" — clears the follow-up. */
export async function clearFollowUp(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE contacts SET follow_up_at = NULL WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * "Resume to Loop 1" — a non-converting Loop 2 contact flows back into general
 * outbound. Adds Loop 1 to its loops (keeping Loop 2 for provenance) and stamps
 * the resume time. Read-modify-write since `loops` is a JSON text column.
 */
export async function resumeToLoop1(db: D1Database, id: string): Promise<void> {
  const row = await db
    .prepare("SELECT loops FROM contacts WHERE id = ?")
    .bind(id)
    .first<{ loops: string }>();
  if (!row) return;
  const loops = normalizeLoops([...parseLoops(row.loops), 1]);
  await db
    .prepare("UPDATE contacts SET loops = ?, resumed_to_loop1_at = ? WHERE id = ?")
    .bind(JSON.stringify(loops), new Date().toISOString(), id)
    .run();
}

export async function addNote(
  db: D1Database,
  contactId: string,
  author: string,
  text: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO notes (id, contact_id, author, text) VALUES (?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), contactId, author, str(text))
    .run();
}

/**
 * Record a touchpoint in the contact's timeline. `type` is the channel key
 * (ad | email | linkedin | call | meeting) — callers validate it against
 * isValidTouchType(). When `loop` is omitted *or out of range*, the contact's
 * primary (lowest) loop is stamped. `created_at` defaults to now via the column
 * default.
 */
export async function logTouchpoint(
  db: D1Database,
  contactId: string,
  type: string,
  owner: string,
  note: string,
  loop?: number,
): Promise<void> {
  // An explicitly supplied loop is range-checked, not trusted: the doc comment
  // above claimed the client couldn't pass a bogus value, but that only held for
  // the resolve-from-contact branch. Anything outside the closed set falls back
  // to the contact's own primary loop.
  let resolvedLoop = loop === 1 || loop === 2 ? loop : undefined;
  if (resolvedLoop === undefined) {
    const row = await db
      .prepare("SELECT loops FROM contacts WHERE id = ?")
      .bind(contactId)
      .first<{ loops: string }>();
    resolvedLoop = row ? Math.min(...parseLoops(row.loops)) : 1;
  }
  await db
    .prepare(
      "INSERT INTO touchpoints (id, contact_id, type, loop, owner, note) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), contactId, type, resolvedLoop, owner, str(note))
    .run();
}

/**
 * Bulk "mark ads sent": log a Dark-ad (`type = "ad"`) touchpoint dated now for
 * each given contact, stamping each contact's primary loop and its own owner
 * (falling back to `actor` when unassigned). One batched write; returns the
 * number of touchpoints created. `created_at` defaults to now, so the date it
 * happened is recorded on each row.
 */
export async function markAdsSent(
  db: D1Database,
  ids: string[],
  actor: string,
): Promise<number> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return 0;

  // Chunked like deleteContacts. Previously this expanded one placeholder per id
  // into a single statement, so a large selection blew past D1's bound-parameter
  // ceiling and hard-failed instead of doing the work.
  const CHUNK = 50;
  let created = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rowsRes = await db
      .prepare(
        `SELECT id, loops, owner FROM contacts WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{ id: string; loops: string; owner: string | null }>();

    const inserts = (rowsRes.results ?? []).map((row) =>
      db
        .prepare(
          "INSERT INTO touchpoints (id, contact_id, type, loop, owner, note) VALUES (?, ?, 'ad', ?, ?, 'Ads sent')",
        )
        .bind(
          crypto.randomUUID(),
          row.id,
          Math.min(...parseLoops(row.loops)),
          row.owner || actor,
        ),
    );
    if (inserts.length) await db.batch(inserts);
    created += inserts.length;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Email templates
//
// Same conventions as the contacts layer above: `db` first, ids minted here with
// crypto.randomUUID(), `created_at` left to the column default, bound parameters
// only, and every multi-statement write in one db.batch so a failure can't leave
// a half-applied state.
//
// One rule specific to variants: EVERY variant statement is constrained by
// `AND template_id = ?`, not just the variant's own id. Without it a caller could
// hand over a variant id belonging to a different template and — through
// promoteVariant — clear template X's default while setting template Y's. Same
// discipline as `Object.hasOwn` in validate.ts: constrain the lookup rather than
// trusting the key.
// ---------------------------------------------------------------------------

type EmailTemplateRow = {
  id: string;
  name: string;
  loop: number;
  status: string;
  send_day: number;
  started_at: string | null;
  concluded_at: string | null;
  created_at: string;
};

type TemplateVariantRow = {
  id: string;
  template_id: string;
  slot: string;
  subject: string;
  body: string;
  is_default: number;
  sends: number;
  opens: number;
  replies: number;
  meetings: number;
  created_at: string;
};

const TEMPLATE_STATUS_SET: ReadonlySet<string> = new Set(TEMPLATE_STATUSES);

/**
 * Coerce a stored status into the union. A hand-edited row carrying 'paused'
 * would otherwise flow straight into templateStatusPill's exhaustive branches;
 * falling back to 'draft' mirrors how parseLoops falls back to [1].
 */
function parseTemplateStatus(raw: string): TemplateStatus {
  return TEMPLATE_STATUS_SET.has(raw) ? (raw as TemplateStatus) : "draft";
}

const TEMPLATE_COLS =
  "id, name, loop, status, send_day, started_at, concluded_at, created_at";
const VARIANT_COLS =
  "id, template_id, slot, subject, body, is_default, sends, opens, replies, meetings, created_at";

/**
 * Load every template with its variants. `now` is the loader's single reference
 * instant — the same one listContacts is called with, so both halves of the page
 * agree on where "today" starts.
 *
 * Two unbounded SELECTs in one Promise.all, children grouped into a Map: the same
 * parent/children fan-out listContacts uses. Unpaginated because a team's
 * template library is a handful of rows, not a contact book.
 */
export async function listTemplates(db: D1Database, now: number): Promise<EmailTemplate[]> {
  const [templatesRes, variantsRes] = await Promise.all([
    // `created_at` defaults to datetime('now'), which has second resolution — two
    // templates created in the same second tie. The id tiebreak keeps the list
    // order fully determined rather than left to the query plan, the same reason
    // analytics.ts sorts its source rows by name after count.
    db
      .prepare(`SELECT ${TEMPLATE_COLS} FROM email_templates ORDER BY created_at DESC, id DESC`)
      .all<EmailTemplateRow>(),
    // Slot-ascending so variants[0] is always A, which the UI relies on for the
    // left/right card order and for "A can't be removed".
    db
      .prepare(`SELECT ${VARIANT_COLS} FROM template_variants ORDER BY slot ASC`)
      .all<TemplateVariantRow>(),
  ]);

  const variantsByTemplate = new Map<string, TemplateVariant[]>();
  for (const v of variantsRes.results ?? []) {
    const list = variantsByTemplate.get(v.template_id) ?? [];
    list.push({
      id: v.id,
      slot: v.slot,
      subject: v.subject ?? "",
      body: v.body ?? "",
      isDefault: Boolean(v.is_default),
      sends: Number(v.sends) || 0,
      opens: Number(v.opens) || 0,
      replies: Number(v.replies) || 0,
      meetings: Number(v.meetings) || 0,
    });
    variantsByTemplate.set(v.template_id, list);
  }

  return (templatesRes.results ?? []).map((row): EmailTemplate => {
    // started_at → a relative integer here, so nothing downstream needs a Date.
    const runningDays = row.started_at ? dayDiff(Date.parse(row.started_at), now) : null;
    return {
      id: row.id,
      name: row.name,
      loop: Number(row.loop) === 2 ? 2 : 1,
      status: parseTemplateStatus(row.status),
      sendDay: Number(row.send_day) || 0,
      runningDays,
      startedLabel: row.started_at ? dateLabel(Date.parse(row.started_at)) : null,
      concludedLabel: row.concluded_at ? dateLabel(Date.parse(row.concluded_at)) : null,
      variants: variantsByTemplate.get(row.id) ?? [],
    };
  });
}

/**
 * Create a template and its variant A in one atomic batch, and return the new
 * template's id so the caller can select it.
 *
 * Batched rather than two awaits because a template with zero variants would
 * render a detail pane with no variant grid — a state the UI has no design for
 * and which nothing else could repair.
 */
export async function createTemplate(
  db: D1Database,
  input: TemplateFields,
): Promise<string> {
  const templateId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO email_templates (id, name, loop, status, send_day) VALUES (?, ?, ?, 'draft', ?)",
      )
      .bind(templateId, str(input.name), input.loop, input.sendDay),
    db
      .prepare(
        "INSERT INTO template_variants (id, template_id, slot, subject, body, is_default) VALUES (?, ?, 'A', '', '', 1)",
      )
      .bind(crypto.randomUUID(), templateId),
  ]);
  return templateId;
}

/** Rename / re-loop / re-schedule a template. False when no row matched. */
export async function updateTemplate(
  db: D1Database,
  id: string,
  input: TemplateFields,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE email_templates SET name = ?, loop = ?, send_day = ? WHERE id = ?")
    .bind(str(input.name), input.loop, input.sendDay, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Move a template between draft / running / concluded, maintaining both
 * timestamps in the same statement.
 *
 * One statement with CASE expressions rather than a read-modify-write so the
 * status and its timestamps can never tear apart under a concurrent edit.
 *
 * The invariant: `started_at` is non-null exactly when the status is not 'draft'.
 * That means sending a template *back* to draft restarts the "running Nd" clock
 * rather than resuming a stale one — the honest reading, since a paused-then-
 * restarted test's day count would otherwise include the gap.
 */
export async function setTemplateStatus(
  db: D1Database,
  id: string,
  status: TemplateStatus,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE email_templates
          SET status = ?1,
              started_at = CASE
                WHEN ?1 = 'draft' THEN NULL
                WHEN started_at IS NULL THEN ?2
                ELSE started_at END,
              concluded_at = CASE WHEN ?1 = 'concluded' THEN ?2 ELSE NULL END
        WHERE id = ?3`,
    )
    .bind(status, nowIso, id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Save one variant's copy. False when the variant isn't on that template. */
export async function saveVariant(
  db: D1Database,
  templateId: string,
  variantId: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE template_variants SET subject = ?, body = ? WHERE id = ? AND template_id = ?",
    )
    .bind(str(subject), str(body), variantId, templateId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Add a variant in the given slot. The new variant is never the default — the
 * point of an A/B test is that the incumbent keeps serving until someone
 * promotes the challenger.
 */
export async function addVariant(
  db: D1Database,
  templateId: string,
  slot: string,
): Promise<{ ok: true } | { ok: false; reason: "exists" | "missing" }> {
  const parent = await db
    .prepare("SELECT id FROM email_templates WHERE id = ?")
    .bind(templateId)
    .first<{ id: string }>();
  if (!parent) return { ok: false, reason: "missing" };

  try {
    await db
      .prepare(
        "INSERT INTO template_variants (id, template_id, slot, subject, body, is_default) VALUES (?, ?, ?, '', '', 0)",
      )
      .bind(crypto.randomUUID(), templateId, slot)
      .run();
    return { ok: true };
  } catch (err) {
    // The unique (template_id, slot) index is the real guard — the check above
    // loses a double-click race. Map the constraint failure to a real answer;
    // rethrowing would surface the opaque "Reference: …" for what is simply
    // "you already have a variant B".
    if (isUniqueViolation(err)) return { ok: false, reason: "exists" };
    throw err;
  }
}

/** True for a D1/SQLite UNIQUE constraint failure. Message-sniffing is the only option — D1 surfaces no error code. */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

/**
 * Make one variant the template's default, clearing the previous one. Batched so
 * a failure can never leave a template with no default at all.
 *
 * The clear is guarded by an EXISTS on the target rather than just
 * `WHERE template_id = ?`. Without that guard, passing a variant id belonging to
 * a *different* template cleared this template's default and then matched nothing
 * to set — committing a template with no default at all. The guard makes the pair
 * all-or-nothing on its own terms, independent of the batch's atomicity, which
 * only covers failure and not a statement that legitimately matches zero rows.
 */
export async function promoteVariant(
  db: D1Database,
  templateId: string,
  variantId: string,
): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare(
        `UPDATE template_variants SET is_default = 0
          WHERE template_id = ?1
            AND EXISTS (
              SELECT 1 FROM template_variants WHERE id = ?2 AND template_id = ?1
            )`,
      )
      .bind(templateId, variantId),
    db
      .prepare("UPDATE template_variants SET is_default = 1 WHERE id = ? AND template_id = ?")
      .bind(variantId, templateId),
  ]);
  return (res[1]?.meta?.changes ?? 0) > 0;
}

/**
 * Remove a challenger variant. Slot A and the last remaining variant are refused
 * — a template with no variants has nothing to send, and the UI has no state for
 * it.
 *
 * Audited, because this destroys copy someone wrote and the dataset is shared by
 * all four users.
 */
export async function removeVariant(
  db: D1Database,
  templateId: string,
  variantId: string,
  actor: string,
): Promise<{ ok: true } | { ok: false; reason: "missing" | "lastVariant" | "slotA" }> {
  const existing = await db
    .prepare(`SELECT ${VARIANT_COLS} FROM template_variants WHERE template_id = ?`)
    .bind(templateId)
    .all<TemplateVariantRow>();
  const rows = existing.results ?? [];
  const target = rows.find((r) => r.id === variantId);
  if (!target) return { ok: false, reason: "missing" };
  if (rows.length <= 1) return { ok: false, reason: "lastVariant" };
  if (target.slot === "A") return { ok: false, reason: "slotA" };

  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, snapshot)
         VALUES (?, ?, 'template_variant.delete', 'template_variant', ?, ?)`,
      )
      .bind(crypto.randomUUID(), actor, target.id, JSON.stringify(target)),
    db
      .prepare("DELETE FROM template_variants WHERE id = ? AND template_id = ?")
      .bind(variantId, templateId),
    // If the removed variant held the default, A inherits it. Unconditional
    // because it is a no-op when A is already the default.
    db
      .prepare("UPDATE template_variants SET is_default = 1 WHERE template_id = ? AND slot = 'A'")
      .bind(templateId),
  ]);
  return { ok: true };
}

/**
 * Hard-delete a template and its variants, snapshotting the whole tree to
 * audit_log first.
 *
 * The snapshot carries the variants as well as the template — unlike
 * deleteContacts, which records the contact but loses its notes. Here the
 * variants *are* the content: the copy is the only irreplaceable thing on the
 * page, and the counters can always be re-pushed.
 */
export async function deleteTemplate(
  db: D1Database,
  id: string,
  actor: string,
): Promise<boolean> {
  const [templateRes, variantsRes] = await Promise.all([
    db
      .prepare(`SELECT ${TEMPLATE_COLS} FROM email_templates WHERE id = ?`)
      .bind(id)
      .first<EmailTemplateRow>(),
    db
      .prepare(`SELECT ${VARIANT_COLS} FROM template_variants WHERE template_id = ?`)
      .bind(id)
      .all<TemplateVariantRow>(),
  ]);
  if (!templateRes) return false;

  const snapshot = JSON.stringify({
    template: templateRes,
    variants: variantsRes.results ?? [],
  });

  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, snapshot)
         VALUES (?, ?, 'template.delete', 'template', ?, ?)`,
      )
      .bind(crypto.randomUUID(), actor, id, snapshot),
    db.prepare("DELETE FROM template_variants WHERE template_id = ?").bind(id),
    // Any sequence-builder step pointing at this template goes with it, and
    // BEFORE it: D1 enforces smartlead_sequence_steps.template_id, so deleting a
    // template that a step still references fails the whole batch on the
    // constraint. Ordering these two statements is what makes a template used in
    // a sequence deletable at all.
    db.prepare("DELETE FROM smartlead_sequence_steps WHERE template_id = ?").bind(id),
    db.prepare("DELETE FROM email_templates WHERE id = ?").bind(id),
  ]);
  return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

const SAVED_VIEW_COLS =
  "id, name, shared, created_by, created_by_name, conditions, created_at";

type SavedViewRow = {
  id: string;
  name: string;
  shared: number;
  created_by: string;
  created_by_name: string;
  conditions: string;
  created_at: string;
};

/**
 * The visibility clause, used by BOTH the list read and the delete.
 *
 * Keeping it in one constant is the point: a delete that resolved its target
 * without it would let a guessed or leaked id remove another user's *private*
 * view. Same discipline as the `AND template_id = ?` on every template_variants
 * write — constrain the lookup rather than trust the key.
 */
const VIEW_VISIBLE_TO = "(shared = 1 OR created_by = ?)";

/**
 * Views the viewer may see: every shared one, plus their own private ones.
 *
 * `created_by` is compared here and then dropped — the returned `mine` is what
 * the UI gets, so three colleagues' email addresses never reach the page payload.
 * Unpaginated for the same reason listTemplates is: this is tens of rows, capped
 * at MAX_SAVED_VIEWS.
 */
export async function listSavedViews(
  db: D1Database,
  viewerEmail: string,
): Promise<SavedView[]> {
  const res = await db
    .prepare(
      // The id tiebreak is not decoration: created_at defaults to datetime('now'),
      // which has second resolution, so two views saved in the same second would
      // otherwise order by whatever the query plan felt like. Same note as
      // listTemplates.
      `SELECT ${SAVED_VIEW_COLS} FROM saved_views
        WHERE ${VIEW_VISIBLE_TO}
        ORDER BY created_at DESC, id DESC`,
    )
    .bind(viewerEmail)
    .all<SavedViewRow>();

  return (res.results ?? []).map((row): SavedView => ({
    id: row.id,
    name: row.name,
    shared: Boolean(row.shared),
    createdByName: row.created_by_name,
    mine: row.created_by === viewerEmail,
    // Tolerant on purpose — a corrupt blob yields a view that matches everything
    // rather than throwing inside a loader and 500ing the whole page.
    conditions: parseConditions(row.conditions),
  }));
}

/**
 * Save a new view and return its id, so the client can select the thing it just
 * made rather than guessing "the newest one" from the revalidated loader and
 * racing a concurrent save by one of the other three users.
 *
 * The count guard is a plain read-then-insert, not a constraint: MAX_SAVED_VIEWS
 * is a payload-size ceiling, so two racing saves landing on 51 is harmless where
 * an unbounded table would not be.
 */
export async function createSavedView(
  db: D1Database,
  input: SavedViewFields,
  creator: { email: string; name: string },
): Promise<{ ok: true; id: string } | { ok: false; reason: "tooMany" }> {
  const countRes = await db
    .prepare("SELECT COUNT(*) AS n FROM saved_views")
    .first<{ n: number }>();
  if ((countRes?.n ?? 0) >= MAX_SAVED_VIEWS) return { ok: false, reason: "tooMany" };

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO saved_views (id, name, shared, created_by, created_by_name, conditions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      str(input.name),
      input.shared ? 1 : 0,
      creator.email,
      str(creator.name),
      JSON.stringify(input.conditions),
    )
    .run();
  return { ok: true, id };
}

/**
 * Delete a saved view, recording it in the audit log first. False when no visible
 * row matched.
 *
 * Deliberately NOT creator-only. Any of the four users can already hard-delete
 * any contact and any template they did not create; inventing a permission model
 * for the cheapest object in the system would be inconsistent, and it would make
 * a shared view created by someone later removed from the allowlist permanently
 * undeletable. The audit row is the accountability mechanism here, as everywhere
 * else. What the visibility clause *does* protect is someone else's private view.
 */
export async function deleteSavedView(
  db: D1Database,
  id: string,
  viewerEmail: string,
  actor: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${SAVED_VIEW_COLS} FROM saved_views WHERE id = ? AND ${VIEW_VISIBLE_TO}`)
    .bind(id, viewerEmail)
    .first<SavedViewRow>();
  if (!row) return false;

  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, snapshot)
         VALUES (?, ?, 'saved_view.delete', 'saved_view', ?, ?)`,
      )
      .bind(crypto.randomUUID(), actor, id, JSON.stringify(row)),
    db
      .prepare(`DELETE FROM saved_views WHERE id = ? AND ${VIEW_VISIBLE_TO}`)
      .bind(id, viewerEmail),
  ]);
  return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
}

/**
 * Write pushed performance counters onto one variant.
 *
 * **Absolute totals, not increments.** The machine caller has no idempotency key
 * and Workers redelivery happens, so `SET sends = ?` is safely repeatable where
 * `sends = sends + ?` would double-count and permanently corrupt the verdict. A
 * caller that only knows deltas should GET the current values and PUT the sum.
 *
 * A null in `stats` means "leave that column alone", expressed as COALESCE rather
 * than an assembled SET list — no part of the SQL text is ever built from input.
 *
 * `target` addresses the variant either by its opaque id or by its stable slot
 * ("B"), the latter being unambiguous thanks to the unique (template_id, slot)
 * index. Not audited: counters are non-destructive and re-pushable, and logging
 * every poll would flood an append-only table.
 */
export async function recordVariantStats(
  db: D1Database,
  target: { templateId: string; variantId?: string; slot?: string },
  stats: StatCounts,
): Promise<boolean> {
  let variantId = target.variantId;
  if (!variantId) {
    if (!target.slot) return false;
    const row = await db
      .prepare("SELECT id FROM template_variants WHERE template_id = ? AND slot = ?")
      .bind(target.templateId, target.slot)
      .first<{ id: string }>();
    if (!row) return false;
    variantId = row.id;
  }

  const res = await db
    .prepare(
      `UPDATE template_variants
          SET sends    = COALESCE(?, sends),
              opens    = COALESCE(?, opens),
              replies  = COALESCE(?, replies),
              meetings = COALESCE(?, meetings)
        WHERE id = ? AND template_id = ?`,
    )
    .bind(stats.sends, stats.opens, stats.replies, stats.meetings, variantId, target.templateId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Smartlead bindings
//
// See migrations/0009_smartlead.sql for why only two tables exist and what is
// deliberately derived instead of stored. Same conventions as everything above:
// `db` first, ids minted here, bound parameters only.
//
// One rule specific to this section: every "last synced" timestamp is written as
// an ISO string from JS, NOT via the column's datetime('now') default. SQLite
// renders that default as 'YYYY-MM-DD HH:MM:SS' with no timezone designator, and
// the loader calls Date.parse on these values to build a label — which would read
// a UTC instant as local time and drift the label by the offset. `created_at` can
// keep the default because it is only ever ordered on, never parsed.
// ---------------------------------------------------------------------------

export type CampaignBinding = {
  loop: number;
  campaignId: string;
  campaignName: string;
  /** "Jul 20"-style labels, precomputed here so no Date runs during render. */
  sequencePushedLabel: string | null;
  leadsPushedLabel: string | null;
  statsSyncedLabel: string | null;
  /** One sentence about the most recent operation, so a reload still says what happened. */
  lastResult: string | null;
};

type CampaignRow = {
  loop: number;
  campaign_id: string;
  campaign_name: string;
  sequence_pushed_at: string | null;
  leads_pushed_at: string | null;
  stats_synced_at: string | null;
  last_result: string | null;
};

/** Which sync timestamp a write should stamp. A literal union, never caller text. */
export type SyncField = "sequence" | "leads" | "stats";

// The column name is resolved through this map rather than built from input —
// the same discipline as recordVariantStats' COALESCE list, where no part of the
// SQL text ever comes from a caller.
const SYNC_COLUMNS: Record<SyncField, string> = {
  sequence: "sequence_pushed_at",
  leads: "leads_pushed_at",
  stats: "stats_synced_at",
};

/** Every loop's campaign binding, keyed by loop. `now` is the loader's instant. */
export async function getCampaignBindings(
  db: D1Database,
  now: number,
): Promise<Record<number, CampaignBinding>> {
  const res = await db
    .prepare(
      "SELECT loop, campaign_id, campaign_name, sequence_pushed_at, leads_pushed_at, stats_synced_at, last_result FROM smartlead_campaigns",
    )
    .all<CampaignRow>();

  const label = (raw: string | null) => {
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : dateLabel(ms);
  };

  const out: Record<number, CampaignBinding> = {};
  for (const row of res.results ?? []) {
    out[Number(row.loop)] = {
      loop: Number(row.loop),
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? "",
      sequencePushedLabel: label(row.sequence_pushed_at),
      leadsPushedLabel: label(row.leads_pushed_at),
      statsSyncedLabel: label(row.stats_synced_at),
      lastResult: row.last_result,
    };
  }
  // `now` is accepted for symmetry with the other readers and to make the
  // dependency explicit; the labels above are absolute, so it isn't consulted.
  void now;
  return out;
}

/**
 * Bind a loop to a campaign, or re-point an existing binding.
 *
 * A plain upsert with no read-modify-write, which is what the `loop` primary key
 * buys: two people linking Loop 1 at once resolve to one row rather than racing.
 * Re-binding clears the sync timestamps — they described the previous campaign,
 * and leaving them would claim a brand-new campaign had already been set up.
 */
export async function bindCampaign(
  db: D1Database,
  loop: number,
  campaignId: string,
  campaignName: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO smartlead_campaigns (loop, campaign_id, campaign_name)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(loop) DO UPDATE SET
         campaign_id = ?2,
         campaign_name = ?3,
         sequence_pushed_at = CASE WHEN smartlead_campaigns.campaign_id = ?2
           THEN smartlead_campaigns.sequence_pushed_at ELSE NULL END,
         leads_pushed_at = CASE WHEN smartlead_campaigns.campaign_id = ?2
           THEN smartlead_campaigns.leads_pushed_at ELSE NULL END,
         stats_synced_at = CASE WHEN smartlead_campaigns.campaign_id = ?2
           THEN smartlead_campaigns.stats_synced_at ELSE NULL END,
         last_result = CASE WHEN smartlead_campaigns.campaign_id = ?2
           THEN smartlead_campaigns.last_result ELSE NULL END`,
    )
    .bind(loop, campaignId, str(campaignName))
    .run();
}

/**
 * Forget a loop's campaign.
 *
 * The smartlead_leads rows are deliberately kept: they record that those contacts
 * were really emailed by that campaign, which stays true after unlinking. Binding
 * the same campaign again therefore still knows who is already in it.
 */
export async function unbindCampaign(db: D1Database, loop: number): Promise<void> {
  await db.prepare("DELETE FROM smartlead_campaigns WHERE loop = ?").bind(loop).run();
}

/** Stamp one sync timestamp and the result sentence shown on the page. */
export async function stampCampaignSync(
  db: D1Database,
  loop: number,
  field: SyncField,
  result: string,
): Promise<void> {
  const column = SYNC_COLUMNS[field];
  if (!column) return;
  await db
    .prepare(
      `UPDATE smartlead_campaigns SET ${column} = ?, last_result = ? WHERE loop = ?`,
    )
    .bind(new Date().toISOString(), result.slice(0, 300), loop)
    .run();
}

/** Contact ids already handed to this campaign. Drives "push only what's new". */
export async function listPushedContactIds(
  db: D1Database,
  campaignId: string,
): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT contact_id FROM smartlead_leads WHERE campaign_id = ?")
    .bind(campaignId)
    .all<{ contact_id: string }>();
  return new Set((res.results ?? []).map((r) => r.contact_id));
}

/**
 * Every address already known to this campaign, lowercased.
 *
 * Used to dedupe an inbound import. Lowercased here rather than at the call site
 * so the one place that decides how addresses compare is the one that reads them.
 */
export async function listPushedEmails(
  db: D1Database,
  campaignId: string,
): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT email FROM smartlead_leads WHERE campaign_id = ?")
    .bind(campaignId)
    .all<{ email: string }>();
  return new Set((res.results ?? []).map((r) => r.email.toLowerCase()));
}

/**
 * Record that these contacts are now in the campaign.
 *
 * INSERT OR IGNORE against the unique (contact_id, campaign_id) index, which is
 * the real guard rather than the caller's pre-flight filter — two operators
 * clicking Push at the same moment both read the same "already pushed" set, and
 * only the index can settle it. Same reasoning as addVariant() above.
 *
 * Called after EACH chunk of a multi-chunk push, never once at the end: if chunk
 * three fails, chunks one and two have already been sent, and losing that record
 * means the retry emails those people a second time.
 */
export async function recordPushedLeads(
  db: D1Database,
  campaignId: string,
  rows: { contactId: string; email: string }[],
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    if (!slice.length) continue;
    await db.batch(
      slice.map((row) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO smartlead_leads (id, contact_id, campaign_id, email) VALUES (?, ?, ?, ?)",
          )
          .bind(crypto.randomUUID(), row.contactId, campaignId, row.email.toLowerCase()),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Smartlead sequence builder
// ---------------------------------------------------------------------------
//
// The authored step list behind /smartlead's sequence builder. A loop with no
// rows here has never been edited and still DERIVES its sequence from send_day,
// which is why every mutator below runs through materializeSequenceSteps first:
// "remove step 2" has to have something to remove, and what the page was showing
// at the moment it was clicked is the derived plan. Materialising on first edit
// (rather than on first page load) is what keeps an untouched loop tracking its
// templates — add a template, and it appears in the sequence by itself.
//
// Every statement is constrained by `AND loop = ?` as well as the step's own id,
// the same discipline the template_variants writers follow: an id belonging to
// the other loop must not be reorderable, retimeable or deletable through this
// loop's card.

type SequenceStepRow = {
  id: string;
  position: number;
  template_id: string;
  variant_slot: string | null;
  delay_days: number;
};

const STEP_COLS = "id, position, template_id, variant_slot, delay_days";

// `position` is not unique (see migration 0012), so the id tiebreak is what keeps
// the order fully determined rather than left to the query plan — the same
// reasoning as listTemplates' `created_at DESC, id DESC`.
const STEP_ORDER = "ORDER BY position ASC, id ASC";

function toStoredStep(row: SequenceStepRow): StoredSequenceStep {
  return {
    id: row.id,
    templateId: row.template_id,
    variantSlot: row.variant_slot,
    delayDays: Number(row.delay_days) || 0,
  };
}

/** One loop's authored steps, in order. Empty means "derive from send_day". */
export async function listSequenceSteps(
  db: D1Database,
  loop: number,
): Promise<StoredSequenceStep[]> {
  const res = await db
    .prepare(`SELECT ${STEP_COLS} FROM smartlead_sequence_steps WHERE loop = ? ${STEP_ORDER}`)
    .bind(loop)
    .all<SequenceStepRow>();
  return (res.results ?? []).map(toStoredStep);
}

/**
 * Both loops' steps in one query, keyed by loop.
 *
 * The loader needs both cards and the table holds tens of rows, so reading it
 * whole costs one D1 round trip instead of two.
 */
export async function listSequenceStepsByLoop(
  db: D1Database,
): Promise<Record<number, StoredSequenceStep[]>> {
  const res = await db
    .prepare(`SELECT loop, ${STEP_COLS} FROM smartlead_sequence_steps ${STEP_ORDER}`)
    .all<SequenceStepRow & { loop: number }>();
  const out: Record<number, StoredSequenceStep[]> = {};
  for (const row of res.results ?? []) {
    const loop = Number(row.loop);
    (out[loop] ??= []).push(toStoredStep(row));
  }
  return out;
}

/**
 * Ensure the loop has authored steps, seeding them from the derived plan.
 *
 * Returns the resulting rows, so a caller that is about to mutate one can find
 * the freshly-minted ids. Seeding writes `variant_slot = NULL` for every step —
 * the derived plan uploads an A/B template as Smartlead's own split, and that is
 * the state the builder must open in, or opening it would silently change what
 * the next upload sends.
 *
 * A loop whose derived plan is empty (no templates, or none with copy) stays
 * empty rather than gaining a placeholder row: the builder's "add a step"
 * dropdown is the way in from there, and an empty sequence is already a blocking
 * problem the page explains.
 */
export async function materializeSequenceSteps(
  db: D1Database,
  loop: number,
  templates: EmailTemplate[],
): Promise<StoredSequenceStep[]> {
  const existing = await listSequenceSteps(db, loop);
  if (existing.length) return existing;

  const derived = buildSequencePlan(templates, loop).included;
  if (!derived.length) return [];

  await db.batch(
    derived.map((row, index) =>
      db
        .prepare(
          `INSERT INTO smartlead_sequence_steps (id, loop, position, template_id, variant_slot, delay_days)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), loop, index + 1, row.templateId, row.delayDays),
    ),
  );
  return listSequenceSteps(db, loop);
}

/**
 * Append a step to the end of the loop's sequence.
 *
 * Returns false when the loop is already at MAX_SEQUENCE_STEPS — the same cap
 * buildSequencePlan refuses to upload past, enforced here too so the list can't
 * grow into a state whose only exit is deleting steps.
 */
export async function appendSequenceStep(
  db: D1Database,
  loop: number,
  templates: EmailTemplate[],
  templateId: string,
  variantSlot: string | null,
): Promise<boolean> {
  const steps = await materializeSequenceSteps(db, loop, templates);
  if (steps.length >= MAX_SEQUENCE_STEPS) return false;

  // A default wait of 3 days rather than 0: consecutive steps with no gap all
  // send the moment the lead enters the campaign, which is the one arrangement
  // nobody wants and the easiest to create by accident. The number is editable
  // in place, and the first step's wait is forced to 0 at build time anyway.
  const delayDays = steps.length === 0 ? 0 : 3;
  await db
    .prepare(
      `INSERT INTO smartlead_sequence_steps (id, loop, position, template_id, variant_slot, delay_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), loop, steps.length + 1, templateId, variantSlot, delayDays)
    .run();
  return true;
}

/** Drop one step. Positions are left with a gap — only their order is read. */
export async function removeSequenceStep(
  db: D1Database,
  loop: number,
  stepId: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM smartlead_sequence_steps WHERE id = ? AND loop = ?")
    .bind(stepId, loop)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Renumber the loop's steps into the given order.
 *
 * `orderedIds` is the full list as the page now shows it, not a move instruction:
 * both the ↑/↓ buttons and the drag handle compute the resulting order client
 * side and post that, so one intent serves both and neither has to describe an
 * edit relative to a state the server may have moved on from.
 *
 * Ids not currently on this loop are ignored, and any step the caller omitted
 * keeps its place after the ones it did send. That is deliberate: two people
 * reordering at once should not have one of them silently delete the other's
 * newly added step.
 */
export async function reorderSequenceSteps(
  db: D1Database,
  loop: number,
  orderedIds: string[],
): Promise<void> {
  const current = await listSequenceSteps(db, loop);
  const known = new Set(current.map((s) => s.id));
  const ordered = orderedIds.filter((id) => known.has(id));
  const seen = new Set(ordered);
  const final = [...ordered, ...current.filter((s) => !seen.has(s.id)).map((s) => s.id)];
  if (!final.length) return;

  await db.batch(
    final.map((id, index) =>
      db
        .prepare("UPDATE smartlead_sequence_steps SET position = ? WHERE id = ? AND loop = ?")
        .bind(index + 1, id, loop),
    ),
  );
}

/** Set one step's wait, in days relative to the previous step. */
export async function setSequenceStepDelay(
  db: D1Database,
  loop: number,
  stepId: string,
  delayDays: number,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE smartlead_sequence_steps SET delay_days = ? WHERE id = ? AND loop = ?")
    .bind(delayDays, stepId, loop)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Pin a step to one variant, or (null) send every variant with copy as a split. */
export async function setSequenceStepVariant(
  db: D1Database,
  loop: number,
  stepId: string,
  variantSlot: string | null,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE smartlead_sequence_steps SET variant_slot = ? WHERE id = ? AND loop = ?")
    .bind(variantSlot, stepId, loop)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Forget the authored sequence, returning the loop to deriving from send_day.
 *
 * Not audited, unlike a contact or template delete: nothing irreplaceable is
 * lost. The copy lives in email_templates, and what disappears is an arrangement
 * the page can show the replacement for immediately.
 */
export async function clearSequenceSteps(db: D1Database, loop: number): Promise<void> {
  await db.prepare("DELETE FROM smartlead_sequence_steps WHERE loop = ?").bind(loop).run();
}

// ---------------------------------------------------------------------------
// Prospecting (see migration 0013 and app/crm/prospecting.ts)
// ---------------------------------------------------------------------------

type ProspectRunRow = {
  id: string;
  agent_id: string | null;
  provider_run_id: string | null;
  previous_run_id: string | null;
  prompt: string;
  status: string;
  stage: string;
  next_poll_at: string | null;
  summary: string | null;
  actions: string | null;
  question: string | null;
  table_id: string | null;
  counts: string | null;
  error: string | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string | null;
};

type ProspectRowRecord = {
  id: string;
  run_id: string;
  position: number;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  linkedin: string | null;
  location: string | null;
  source_url: string | null;
  email_confidence: string | null;
  dedupe: string | null;
  existing_contact_id: string | null;
  promoted_contact_id: string | null;
};

const RUN_COLS = `id, agent_id, provider_run_id, previous_run_id, prompt, status, stage,
  next_poll_at, summary, actions, question, table_id, counts, error,
  created_by, created_by_name, created_at, updated_at`;

const PROSPECT_COLS = `id, run_id, position, name, company, title, email, linkedin,
  location, source_url, email_confidence, dedupe, existing_contact_id, promoted_contact_id`;

/**
 * The server-side view of a run: everything the poll state machine needs, which
 * is strictly more than the client is given (the provider ids and next_poll_at
 * never leave the server).
 */
export type StoredProspectRun = {
  id: string;
  agentId: string | null;
  providerRunId: string | null;
  prompt: string;
  status: string;
  stage: ProspectStage;
  nextPollAt: number | null;
  summary: string | null;
  actions: unknown[];
  question: string | null;
  tableId: string | null;
  counts: RunCounts | null;
  error: string | null;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number | null;
};

/** Tolerant JSON read: a corrupt blob degrades the panel, it doesn't 500 a loader. */
function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * `Date.parse` a column written as an ISO string from JS, returning null for a
 * missing or unreadable value. Migration 0013 explains why these columns must
 * never use SQLite's datetime('now') default: it emits no timezone designator,
 * so this call would read a UTC instant as local time.
 */
function parseIso(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function toStoredRun(row: ProspectRunRow): StoredProspectRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    providerRunId: row.provider_run_id,
    prompt: row.prompt,
    status: row.status,
    stage: isValidProspectStage(row.stage) ? row.stage : "failed",
    nextPollAt: parseIso(row.next_poll_at),
    summary: row.summary,
    actions: parseJsonColumn<unknown[]>(row.actions, []),
    question: row.question,
    tableId: row.table_id,
    counts: parseJsonColumn<RunCounts | null>(row.counts, null),
    error: row.error,
    createdBy: row.created_by,
    // created_at keeps the datetime('now') default because it is only ordered
    // on — but the thread's "3m ago" label reads it, so it is parsed as UTC
    // explicitly here rather than being handed to a bare Date.parse, which would
    // read "2026-08-18 14:03:00" as local time.
    createdAtMs: Date.parse(row.created_at.replace(" ", "T") + "Z"),
    updatedAtMs: parseIso(row.updated_at),
  };
}

function toProspect(row: ProspectRowRecord): Prospect {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    title: row.title,
    email: row.email,
    linkedin: row.linkedin,
    location: row.location,
    sourceUrl: row.source_url,
    emailConfidence: isValidEmailConfidence(row.email_confidence)
      ? row.email_confidence
      : "none",
    dedupe: isValidDedupeReason(row.dedupe) ? row.dedupe : null,
    existingContactId: row.existing_contact_id,
    promotedContactId: row.promoted_contact_id,
  };
}

/**
 * The runs of one thread, oldest first.
 *
 * A thread is every run sharing an `agent_id` — an Origami agent keeps its
 * workspace and conversation across runs, so that grouping IS the conversation.
 * A run whose agent id was never assigned (its POST /agents failed) is a thread
 * of one, addressed by its own id.
 */
export async function listProspectThread(
  db: D1Database,
  runId: string,
  viewerEmail: string,
): Promise<StoredProspectRun[]> {
  const anchor = await db
    .prepare(`SELECT ${RUN_COLS} FROM prospect_runs WHERE id = ? AND created_by = ?`)
    .bind(runId, viewerEmail)
    .first<ProspectRunRow>();
  if (!anchor) return [];
  if (!anchor.agent_id) return [toStoredRun(anchor)];

  const res = await db
    .prepare(
      // The id tiebreak matters here for the same reason listSavedViews gives:
      // created_at has second resolution, and a follow-up run answering a
      // question can easily land in the same second as the run before it.
      `SELECT ${RUN_COLS} FROM prospect_runs
        WHERE agent_id = ? AND created_by = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(anchor.agent_id, viewerEmail)
    .all<ProspectRunRow>();

  return (res.results ?? []).map(toStoredRun);
}

/** The viewer's most recent run, used to restore the panel when it reopens. */
export async function latestProspectRun(
  db: D1Database,
  viewerEmail: string,
): Promise<StoredProspectRun | null> {
  const row = await db
    .prepare(
      `SELECT ${RUN_COLS} FROM prospect_runs
        WHERE created_by = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(viewerEmail)
    .first<ProspectRunRow>();
  return row ? toStoredRun(row) : null;
}

/** Every prospect of one run, in the order the agent ranked them. */
export async function listProspects(db: D1Database, runId: string): Promise<Prospect[]> {
  const res = await db
    .prepare(`SELECT ${PROSPECT_COLS} FROM prospects WHERE run_id = ? ORDER BY position ASC`)
    .bind(runId)
    .all<ProspectRowRecord>();
  return (res.results ?? []).map(toProspect);
}

/** Prospects across a whole thread, keyed by run id. One query, not one per run. */
export async function listProspectsForRuns(
  db: D1Database,
  runIds: string[],
): Promise<Map<string, Prospect[]>> {
  const out = new Map<string, Prospect[]>();
  if (!runIds.length) return out;
  // Bounded by the thread length, which is bounded by PROSPECT_RUN_RULE — but
  // the placeholder list is built from the ids' count, never from their content.
  const holes = runIds.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT ${PROSPECT_COLS} FROM prospects WHERE run_id IN (${holes})
        ORDER BY position ASC`,
    )
    .bind(...runIds)
    .all<ProspectRowRecord>();
  for (const row of res.results ?? []) {
    const list = out.get(row.run_id) ?? [];
    list.push(toProspect(row));
    out.set(row.run_id, list);
  }
  return out;
}

/**
 * True when this viewer already has a run in flight.
 *
 * Checked before every start, because an Origami agent does one run at a time
 * and the org's concurrent-run pool is as small as ONE on a starter plan. Losing
 * that race costs a 429 and a confusing error; catching it here costs a read.
 */
export async function hasRunningProspectRun(
  db: D1Database,
  viewerEmail: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM prospect_runs
        WHERE created_by = ? AND status = 'running' AND stage != 'failed' LIMIT 1`,
    )
    .bind(viewerEmail)
    .first<{ id: string }>();
  return !!row;
}

/**
 * Insert the run row BEFORE the provider call.
 *
 * Order matters: a run row with no agent_id is a run whose POST /agents never
 * came back, and it can be shown as failed with the reason. Calling first and
 * inserting after would lose a started (and billed) run whenever the write lost.
 */
export async function createProspectRun(
  db: D1Database,
  input: {
    prompt: string;
    agentId: string | null;
    previousRunId: string | null;
    createdBy: string;
    createdByName: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO prospect_runs
         (id, agent_id, previous_run_id, prompt, status, stage, created_by, created_by_name, updated_at)
       VALUES (?, ?, ?, ?, 'running', 'starting', ?, ?, ?)`,
    )
    .bind(
      id,
      input.agentId,
      input.previousRunId,
      input.prompt,
      input.createdBy,
      input.createdByName,
      new Date().toISOString(),
    )
    .run();
  return id;
}

/**
 * Patch a run. Only the named fields move; `updated_at` always does.
 *
 * A hand-built SET list rather than one statement per caller, because the poll
 * state machine writes a different subset at each stage and five near-identical
 * UPDATEs would drift. Column names come from this function's own literals, not
 * from the caller.
 */
export async function updateProspectRun(
  db: D1Database,
  runId: string,
  patch: {
    agentId?: string | null;
    providerRunId?: string | null;
    status?: string;
    stage?: ProspectStage;
    nextPollAt?: number | null;
    summary?: string | null;
    actions?: unknown[] | null;
    question?: string | null;
    tableId?: string | null;
    counts?: RunCounts | null;
    error?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  const put = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };

  if ("agentId" in patch) put("agent_id", patch.agentId ?? null);
  if ("providerRunId" in patch) put("provider_run_id", patch.providerRunId ?? null);
  if ("status" in patch) put("status", patch.status);
  if ("stage" in patch) put("stage", patch.stage);
  // ISO string, never datetime('now') — this column is Date.parse()d. See 0013.
  if ("nextPollAt" in patch) {
    put("next_poll_at", patch.nextPollAt ? new Date(patch.nextPollAt).toISOString() : null);
  }
  if ("summary" in patch) put("summary", patch.summary ?? null);
  if ("actions" in patch) put("actions", patch.actions ? JSON.stringify(patch.actions) : null);
  if ("question" in patch) put("question", patch.question ?? null);
  if ("tableId" in patch) put("table_id", patch.tableId ?? null);
  if ("counts" in patch) put("counts", patch.counts ? JSON.stringify(patch.counts) : null);
  if ("error" in patch) put("error", patch.error ?? null);

  put("updated_at", new Date().toISOString());

  await db
    .prepare(`UPDATE prospect_runs SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, runId)
    .run();
}

/**
 * Store a run's mapped, deduped prospects.
 *
 * Deletes first so a re-read of the same table replaces rather than appends —
 * the `reading` stage is re-enterable if a page of rows times out, and these are
 * a snapshot of one table, not an accumulating log.
 */
export async function replaceProspects(
  db: D1Database,
  runId: string,
  rows: DedupedProspect[],
): Promise<number> {
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM prospects WHERE run_id = ?`).bind(runId),
  ];
  rows.forEach((row, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO prospects
             (id, run_id, position, name, company, title, email, linkedin, location,
              source_url, email_confidence, dedupe, existing_contact_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          runId,
          index,
          row.name,
          row.company,
          row.title,
          row.email,
          row.linkedin,
          row.location,
          row.sourceUrl,
          row.emailConfidence,
          row.dedupe,
          row.existingContactId,
        ),
    );
  });
  // One batch: a half-written result set would show a truncated list with no
  // sign that anything was missing.
  await db.batch(statements);
  return rows.length;
}

/**
 * Mark prospects as promoted, so a second click adds nothing.
 *
 * The contact ids are positional against `ids` — createManyContacts inserts in
 * order and drops only nameless rows, which validateContact has already
 * rejected by this point, so the two lists line up.
 */
export async function markProspectsPromoted(
  db: D1Database,
  runId: string,
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  const now = new Date().toISOString();
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          // AND run_id = ? for the reason every template_variants write is
          // scoped by template_id: without it a caller could mark another run's
          // prospect promoted by passing its id.
          `UPDATE prospects SET promoted_contact_id = ?
            WHERE id = ? AND run_id = ? AND promoted_contact_id IS NULL`,
        )
        .bind(now, id, runId),
    ),
  );
}
