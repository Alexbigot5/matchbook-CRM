// Server-only data-access layer for the CRM. Persists to Cloudflare D1 and
// converts the stored absolute timestamps into the relative `daysAgo` /
// `followUp` values that app/crm/data.ts and the UI expect. Keeping every date
// calculation here (against a single `now` captured in the loader) is what keeps
// SSR and client hydration deterministic — no `Date` runs in the render path.

import {
  buildNameIndex,
  DEAL_STAGES,
  isClosedDealStage,
  normalizeName,
  splitCategoryTags,
} from "../crm/data";
import type {
  Company,
  Contact,
  Deal,
  DealRole,
  DealStakeholder,
  Note,
  Tag,
  Touch,
} from "../crm/data";
import {
  TEMPLATE_STATUSES,
  type EmailTemplate,
  type TemplateStatus,
  type TemplateVariant,
} from "../crm/templates";
import {
  buildSequencePlan,
  MAX_SEQUENCE_STEPS,
  SENT_STATUS,
  type ContactSendUpdate,
  type EmailEvent,
  type StoredLeadState,
  type StoredSequenceStep,
} from "../crm/smartlead-map";
import { REPLY_NOTE_PREFIX, SEND_NOTE_PREFIX } from "../crm/campaigns";
import { REPLY_PROMOTES_FROM, REPLY_STATUS, type ReplyCard } from "../crm/unipile-map";
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
 *
 * `dayKeys` is the same axis as `YYYY-MM-DD` UTC dates, and exists so the
 * campaign chart can join Smartlead's own timestamps onto it. Those arrive as
 * ISO strings whose first ten characters ARE the UTC day, which is what
 * readCampaignEventStats() groups on — so the join is a string lookup and, once
 * again, no Date reaches the render path. Emitted here rather than derived in
 * the page because this is the one function that owns what a day means.
 */
export function buildAnalyticsLabels(
  now: number,
  days = 14,
): { asOf: string; dayLabels: string[]; dayKeys: string[] } {
  const today = startOfUTCDay(now);
  const dayLabels: string[] = [];
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const ms = today - i * DAY;
    dayLabels.push(dateLabel(ms));
    dayKeys.push(new Date(ms).toISOString().slice(0, 10));
  }
  return { asOf: dateLabel(now), dayLabels, dayKeys };
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
  company_id: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  owner: string | null;
  status: string;
  loops: string;
  source: string | null;
  category: string | null;
  arr: string | null;
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

  const [contactsRes, notesRes, touchesRes, tagsRes] = await Promise.all([
    (limit === null
      ? db.prepare(
          "SELECT id, name, company, company_id, email, phone, linkedin, owner, status, loops, source, category, arr, follow_up_at, resumed_to_loop1_at, dead_reason, created_at FROM contacts ORDER BY created_at DESC",
        )
      : db
          .prepare(
            "SELECT id, name, company, company_id, email, phone, linkedin, owner, status, loops, source, category, arr, follow_up_at, resumed_to_loop1_at, dead_reason, created_at FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?",
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
    // Read in the same Promise.all as the others rather than per contact. Both
    // tables are empty until something new is created (migrations/0020), so on
    // today's book this returns nothing and costs one round trip.
    db
      .prepare(
        `SELECT ct.contact_id, t.id, t.name
           FROM contact_tags ct
           JOIN tags t ON t.id = ct.tag_id
          ORDER BY t.name`,
      )
      .all<{ contact_id: string; id: string; name: string }>(),
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

  // Empty for every contact created before tags existed. That is the expected
  // steady state for most of the book for a while, not a gap to be filled.
  const tagsByContact = new Map<string, Tag[]>();
  for (const t of tagsRes.results ?? []) {
    const list = tagsByContact.get(t.contact_id) ?? [];
    list.push({ id: t.id, name: t.name });
    tagsByContact.set(t.contact_id, list);
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
      companyId: row.company_id ?? null,
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
      category: row.category ?? null,
      arr: row.arr ?? null,
      tags: tagsByContact.get(row.id) ?? [],
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
  category?: string | null;
  arr?: string | null;
};

/**
 * Coerce to a trimmed string. Callers now validate through app/lib/validate.ts,
 * but this layer is reachable with whatever JSON.parse produced, and a bare
 * `.trim()` on a number threw a TypeError rather than rejecting cleanly.
 */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a batch of free-text company names to company ids in a fixed number of
 * round trips, regardless of how many rows the import has.
 *
 * The per-row alternative is findOrCreateCompanyByName inside the loop, which on
 * a 2,000-row CSV is up to 4,000 sequential D1 calls. Distinct companies in a
 * real import are a small fraction of its rows, so this reads what already
 * exists, INSERTs only what is missing, and re-reads to pick up ids — three
 * passes of chunked statements.
 *
 * INSERT OR IGNORE rather than a pre-check, because the UNIQUE index on
 * normalized_name is the arbiter (same reasoning as findOrCreateCompanyByName's
 * retry): a concurrent import inserting the same company is ignored rather than
 * throwing, and the re-read below picks up whichever row won.
 *
 * Keyed by NORMALIZED name so it matches what findOrCreateCompanyByName and
 * migrations/0019 both produce. The display spelling stored for a new company is
 * the first one seen in the file.
 */
async function resolveCompanyIdsByName(
  db: D1Database,
  rawNames: (string | undefined)[],
): Promise<Map<string, string>> {
  const display = new Map<string, string>();
  for (const raw of rawNames) {
    const shown = str(raw);
    const key = normalizeName(shown);
    if (key && !display.has(key)) display.set(key, shown);
  }
  const found = new Map<string, string>();
  if (!display.size) return found;

  const CHUNK = 100;
  const readInto = async (keys: string[]) => {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const res = await db
        .prepare(
          `SELECT id, normalized_name FROM companies
            WHERE normalized_name IN (${slice.map(() => "?").join(", ")})`,
        )
        .bind(...slice)
        .all<{ id: string; normalized_name: string }>();
      for (const r of res.results ?? []) found.set(r.normalized_name, r.id);
    }
  };

  const keys = [...display.keys()];
  await readInto(keys);

  const missing = keys.filter((k) => !found.has(k));
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK);
    await db.batch(
      slice.map((k) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO companies (id, name, normalized_name) VALUES (?, ?, ?)",
          )
          .bind(crypto.randomUUID(), display.get(k) ?? k, k),
      ),
    );
  }
  if (missing.length) await readInto(missing);
  return found;
}

/**
 * Find an industry tag by its normalized name, creating it only on a genuine
 * miss. Same shape, and the same race handling, as findOrCreateCompanyByName:
 * the UNIQUE index on normalized_name is the arbiter, so a concurrent writer
 * that inserted the same tag between our SELECT and INSERT wins and we re-read
 * whichever row won rather than failing the whole create.
 *
 * Returns null for a blank name, which is how splitCategoryTags' dropped empty
 * segments stay dropped instead of minting a nameless tag.
 */
export async function findOrCreateTag(db: D1Database, name: string): Promise<Tag | null> {
  const display = str(name);
  const normalized = normalizeName(display);
  if (!normalized) return null;

  const existing = await db
    .prepare("SELECT id, name FROM tags WHERE normalized_name = ?")
    .bind(normalized)
    .first<{ id: string; name: string }>();
  if (existing) return { id: existing.id, name: existing.name };

  const row = { id: crypto.randomUUID(), name: display };
  try {
    await db
      .prepare("INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?)")
      .bind(row.id, row.name, normalized)
      .run();
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await db
      .prepare("SELECT id, name FROM tags WHERE normalized_name = ?")
      .bind(normalized)
      .first<{ id: string; name: string }>();
    if (!winner) throw err;
    return { id: winner.id, name: winner.name };
  }
}

/**
 * Derive one NEW contact's industry tags from its raw category and attach them.
 *
 * Called only from the paths that create a brand-new contact row. It is
 * deliberately not reachable from any update path: nothing re-derives tags when
 * a category is edited later, and nothing walks the contacts that predate
 * migration 0020. See that migration's header for why.
 *
 * INSERT OR IGNORE against the composite primary key, so calling this twice for
 * the same contact cannot double-tag it.
 */
export async function syncTagsFromCategory(
  db: D1Database,
  contactId: string,
  rawCategory: string | null,
): Promise<void> {
  const names = splitCategoryTags(rawCategory);
  if (!names.length) return;

  const ids: string[] = [];
  for (const name of names) {
    const tag = await findOrCreateTag(db, name);
    if (tag && !ids.includes(tag.id)) ids.push(tag.id);
  }
  if (!ids.length) return;

  await db.batch(
    ids.map((tagId) =>
      db
        .prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)")
        .bind(contactId, tagId),
    ),
  );
}

/**
 * The bulk form, for a whole import at once.
 *
 * findOrCreateTag in a loop is right for one contact and wrong for two thousand:
 * it is up to two sequential D1 round trips per segment, which on a full CSV is
 * thousands of calls before a single tag row is written. This is the same
 * read / INSERT OR IGNORE / re-read shape resolveCompanyIdsByName uses, and for
 * the same reason — distinct industries in a real import are a tiny fraction of
 * its rows.
 *
 * Keyed by NORMALIZED name so it agrees with findOrCreateTag about identity. The
 * display spelling stored for a new tag is the first one seen in the file.
 */
async function syncTagsForNewContacts(
  db: D1Database,
  rows: { contactId: string; category: string | null }[],
): Promise<void> {
  const display = new Map<string, string>();
  const perContact: { contactId: string; keys: string[] }[] = [];
  for (const row of rows) {
    const keys: string[] = [];
    for (const seg of splitCategoryTags(row.category)) {
      const key = normalizeName(seg);
      if (!key) continue;
      if (!display.has(key)) display.set(key, seg);
      if (!keys.includes(key)) keys.push(key);
    }
    if (keys.length) perContact.push({ contactId: row.contactId, keys });
  }
  if (!display.size) return;

  const found = new Map<string, string>();
  const CHUNK = 100;
  const readInto = async (keys: string[]) => {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const res = await db
        .prepare(
          `SELECT id, normalized_name FROM tags
            WHERE normalized_name IN (${slice.map(() => "?").join(", ")})`,
        )
        .bind(...slice)
        .all<{ id: string; normalized_name: string }>();
      for (const r of res.results ?? []) found.set(r.normalized_name, r.id);
    }
  };

  const keys = [...display.keys()];
  await readInto(keys);

  const missing = keys.filter((k) => !found.has(k));
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK);
    await db.batch(
      slice.map((k) =>
        db
          .prepare("INSERT OR IGNORE INTO tags (id, name, normalized_name) VALUES (?, ?, ?)")
          .bind(crypto.randomUUID(), display.get(k) ?? k, k),
      ),
    );
  }
  if (missing.length) await readInto(missing);

  const links: D1PreparedStatement[] = [];
  for (const { contactId, keys: tagKeys } of perContact) {
    for (const key of tagKeys) {
      const tagId = found.get(key);
      if (!tagId) continue;
      links.push(
        db
          .prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)")
          .bind(contactId, tagId),
      );
    }
  }
  const LINK_CHUNK = 50;
  for (let i = 0; i < links.length; i += LINK_CHUNK) {
    await db.batch(links.slice(i, i + LINK_CHUNK));
  }
}

/**
 * `companyId` is passed in rather than resolved here because this builds a
 * statement synchronously (db.batch needs them all up front) and resolving a
 * company is a read. Callers resolve first — see resolveCompanyIdsByName.
 *
 * Null is a legitimate value: a contact with no company string has no company
 * row, and must keep rendering exactly as it does today (migrations/0017).
 *
 * `id` is a parameter for the same reason: the caller has to know the id it just
 * wrote in order to attach contact_tags rows to it, and a uuid minted in here
 * would be invisible to them.
 */
function insertContactStmt(
  db: D1Database,
  input: NewContactInput,
  companyId: string | null,
  id: string,
) {
  const name = str(input.name);
  const followUpAt = new Date().toISOString(); // new contacts are "due today"
  const source = str(input.source) || null;
  const email = str(input.email) || null;
  const phone = str(input.phone) || null;
  const linkedin = str(input.linkedin) || null;
  const category = str(input.category) || null;
  const arr = str(input.arr) || null;
  return db
    .prepare(
      "INSERT INTO contacts (id, name, company, company_id, email, phone, linkedin, owner, status, loops, source, follow_up_at, category, arr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      name,
      str(input.company),
      companyId,
      email,
      phone,
      linkedin,
      str(input.owner) || null,
      str(input.status) || "New",
      JSON.stringify(normalizeLoops(input.loops)),
      source,
      followUpAt,
      category,
      arr,
    );
}

export async function createContact(db: D1Database, input: NewContactInput): Promise<void> {
  // Resolve the company on the way in so company_id is set going forward, not
  // only on the historical backfill in migrations/0019. A blank company yields
  // null and the contact is written exactly as it always was.
  const company = await findOrCreateCompanyByName(db, str(input.company));
  const id = crypto.randomUUID();
  await insertContactStmt(db, input, company?.id ?? null, id).run();
  // Tags are derived here, at creation, and nowhere else — see
  // syncTagsFromCategory and migrations/0020. A contact whose category is blank
  // simply gets none.
  await syncTagsFromCategory(db, id, str(input.category) || null);
}

/** How many rows a bulk insert actually wrote, and what it turned away. */
export type CreateManyResult = {
  inserted: number;
  skipped: { email: number; name: number };
};

/**
 * Everything needed to answer "is this person already in the CRM", read in one
 * lean query.
 *
 * Deliberately not `listContacts` — that pulls every note and touchpoint in the
 * database to shape full `Contact` objects, and the only two fields a dedupe
 * pass reads are the name and the address. Emails are trimmed and lowercased to
 * match `listPushedEmails`, so the CRM and Smartlead agree on when two addresses
 * are the same inbox; names go through the shared `buildNameIndex`, which is the
 * same index the contacts table builds for its cross-owner conflict flag.
 */
async function loadDedupeIndex(db: D1Database): Promise<{
  emails: Set<string>;
  names: Map<string, { id: string; name: string }[]>;
}> {
  const res = await db
    .prepare("SELECT id, name, email FROM contacts")
    .all<{ id: string; name: string; email: string | null }>();
  const existing = res.results ?? [];

  const emails = new Set<string>();
  for (const c of existing) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return { emails, names: buildNameIndex(existing) };
}

/**
 * Bulk insert (CSV import) in batched, atomic chunks.
 *
 * `dedupe` is opt-in and off by default because the callers differ in what
 * protection they already have. The CSV import is the one route with none — it
 * writes whatever the file says, so the same list pasted twice lands twice. The
 * other three callers dedupe upstream against rules this function can't see
 * (Origami flags prospects at read time via `dedupeProspects`; the Smartlead
 * import compares against the campaign's pushed set, not the contact book), and
 * turning this on for them would silently drop rows they mean to write —
 * notably any lead sharing a name with an existing contact.
 *
 * When on, the checks run per row in identity order, mirroring `dedupeProspects`:
 * email first, because an address is an identity and two people with one name are
 * still two people, then name. Skips are counted by reason rather than collapsed
 * into one number so the import can report which rule turned a row away.
 *
 * Chunking is unchanged — dedupe filters the list, it does not touch how the
 * survivors are batched.
 */
export async function createManyContacts(
  db: D1Database,
  rows: NewContactInput[],
  opts: { dedupe?: boolean } = {},
): Promise<CreateManyResult> {
  const valid = rows.filter((r) => r.name && r.name.trim());
  const skipped = { email: 0, name: 0 };

  let toInsert = valid;
  if (opts.dedupe) {
    const { emails, names } = await loadDedupeIndex(db);
    toInsert = [];
    for (const row of valid) {
      const email = (row.email ?? "").trim().toLowerCase();
      if (email && emails.has(email)) {
        skipped.email++;
        continue;
      }
      if (names.has(normalizeName(row.name))) {
        skipped.name++;
        continue;
      }
      // Fold the accepted row into the index so a file containing the same
      // person twice is caught on the second occurrence too — the DB read
      // happened before any of these inserts.
      if (email) emails.add(email);
      const key = normalizeName(row.name);
      if (key) names.set(key, [{ id: "", name: row.name }]);
      toInsert.push(row);
    }
  }

  // Companies for the whole surviving batch, in a fixed number of round trips.
  // Resolved AFTER dedupe so a file full of rows that are all about to be
  // skipped does not mint companies for them. Nothing about the dedupe rules
  // above changes — this only fills in company_id for the rows that survive.
  const companyIds = await resolveCompanyIdsByName(db, toInsert.map((r) => r.company));

  // Ids up front rather than inside insertContactStmt: the tag pass below has to
  // name the rows it is tagging, and a uuid minted inside the statement builder
  // would not be visible out here.
  const withIds = toInsert.map((r) => ({ row: r, id: crypto.randomUUID() }));

  const CHUNK = 50;
  for (let i = 0; i < withIds.length; i += CHUNK) {
    const chunk = withIds
      .slice(i, i + CHUNK)
      .map(({ row, id }) =>
        insertContactStmt(db, row, companyIds.get(normalizeName(str(row.company))) ?? null, id),
      );
    if (chunk.length) await db.batch(chunk);
  }

  // After the contacts land, never before: a contact_tags row references
  // contacts(id), so tagging first would point at rows that do not exist yet.
  // Only these newly inserted ids are touched — the rows dedupe turned away, and
  // every contact already in the book, are not read or written here.
  await syncTagsForNewContacts(
    db,
    withIds.map(({ row, id }) => ({ contactId: id, category: str(row.category) || null })),
  );

  return { inserted: toInsert.length, skipped };
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
      // Replies go with the contact, like their notes and touchpoints: the row
      // carries a snippet of what the person wrote, and keeping that after the
      // contact is gone would leave orphaned message text nothing can surface or
      // re-delete. The audit snapshot above is of the contact row only, which is
      // the same bargain notes and touchpoints already make.
      db.prepare(`DELETE FROM contact_replies WHERE contact_id IN (${placeholders})`).bind(...chunk),
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
 * were handed to that campaign — and, in `emailed_steps`, which of its sends have
 * already landed on them — both of which stay true after unlinking. Binding the
 * same campaign again therefore still knows who is already in it, and does not
 * log its sends onto their timelines a second time.
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

/**
 * Contact ids already handed to this campaign. Drives "push only what's new" on
 * /smartlead, and is the cohort /analytics' campaign progress breakdown counts
 * against — the leads the campaign was given, rather than every contact on the
 * loop.
 */
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
 * How many leads each campaign holds, keyed by Smartlead campaign id.
 *
 * One grouped read rather than a query per loop: /analytics needs the figure for
 * both loops at once and the table is small. Keyed on campaign_id rather than
 * loop for the reason migration 0009 denormalises that column — a loop rebound to
 * a different campaign must not retroactively claim the old campaign's pushes.
 */
export async function countPushedLeadsByCampaign(
  db: D1Database,
): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT campaign_id, COUNT(*) AS n FROM smartlead_leads GROUP BY campaign_id")
    .all<{ campaign_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of res.results ?? []) out[row.campaign_id] = Number(row.n) || 0;
  return out;
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
// Smartlead sends -> contacts
// ---------------------------------------------------------------------------
//
// Turning "Smartlead says it emailed this address" into the two things the CRM
// already understands: an `email` touchpoint on the contact's timeline, and a
// status that is no longer "New". Everything about WHICH sends are new is
// decided by planContactSends() in app/crm/smartlead-map.ts; this half only
// reads the state it needs and writes what it is told.

/**
 * Format an instant the way `datetime('now')` does: UTC, space-separated, no
 * timezone designator.
 *
 * Every other touchpoint's `created_at` comes from that column default, and
 * listContacts() orders touchpoints by the raw string. Writing an ISO
 * `2026-08-22T09:00:00.000Z` alongside a stored `2026-08-22 09:00:00` would sort
 * every backdated send after every logged touch on the same day, and would also
 * be parsed on a different timezone assumption than its neighbours. So a
 * Smartlead timestamp is converted into the format the column already speaks
 * rather than the format it arrived in — the opposite of the smartlead_campaigns
 * sync stamps, which are ISO precisely because nothing else writes them.
 *
 * Returns null for anything unparseable, which the caller turns into "now".
 */
function sqliteUTC(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

type LeadStateRow = {
  contact_id: string;
  email: string;
  emailed_steps: string | null;
  status: string;
  owner: string | null;
  loops: string;
};

/** Send keys already logged for a lead. Same defensive shape as parseLoops. */
function parseSendKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && key.length > 0);
  } catch {
    return [];
  }
}

/**
 * Every lead in this campaign, joined to the contact it points at.
 *
 * An INNER JOIN on purpose: deleteContacts() drops a contact's lead links in the
 * same batch as the contact, so a link with no contact is a row that should not
 * exist, and a send arriving for one has nowhere to land.
 */
export async function listCampaignLeadState(
  db: D1Database,
  campaignId: string,
): Promise<StoredLeadState[]> {
  const res = await db
    .prepare(
      `SELECT l.contact_id, l.email, l.emailed_steps, c.status, c.owner, c.loops
         FROM smartlead_leads l
         JOIN contacts c ON c.id = l.contact_id
        WHERE l.campaign_id = ?`,
    )
    .bind(campaignId)
    .all<LeadStateRow>();

  return (res.results ?? []).map((row) => ({
    contactId: row.contact_id,
    email: (row.email ?? "").toLowerCase(),
    status: row.status,
    owner: row.owner ?? null,
    loop: Math.min(...parseLoops(row.loops)),
    loggedKeys: parseSendKeys(row.emailed_steps),
  }));
}

/** How many of a campaign's leads Smartlead has confirmed at least one send for. */
export async function countEmailedLeads(
  db: D1Database,
  campaignId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM smartlead_leads
        WHERE campaign_id = ? AND last_emailed_at IS NOT NULL`,
    )
    .bind(campaignId)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * Write one `email` touchpoint per newly observed send, move any still-"New"
 * contact to Contacted, and remember the send keys so the next sync skips them.
 *
 * The status UPDATE carries `AND status = 'New'` rather than trusting the read
 * that produced `markContacted`: the plan is built from a snapshot, and a sync
 * of a two-thousand-row campaign is long enough for someone to mark a contact
 * Replied in the CRM while it runs. The WHERE clause is what makes the write
 * lose that race instead of winning it.
 *
 * Statements are flushed in fixed-size batches rather than one batch per
 * contact, because a contact contributes between two and half a dozen of them —
 * chunking by contact would size the batch on a number nobody controls. A batch
 * is atomic, so a failure mid-sync leaves earlier batches applied; that is safe
 * here for the same reason recordPushedLeads() writes after each chunk, since
 * the keys written alongside each touchpoint are what stop it being written
 * twice.
 */
export async function recordContactSends(
  db: D1Database,
  campaignId: string,
  campaignName: string,
  updates: ContactSendUpdate[],
  actor: string,
): Promise<{ touchpoints: number; contacted: number }> {
  const BATCH = 50;
  const label = (campaignName || "Smartlead").slice(0, 60);
  let statements: D1PreparedStatement[] = [];
  // Which statements in the pending batch are the status UPDATE, so the count
  // reported back is the number of contacts that actually moved rather than the
  // number the plan hoped to move. They differ exactly when the guard clause
  // above fires, which is the one case worth not lying about.
  let statusSlots: number[] = [];
  let touchpoints = 0;
  let contacted = 0;

  const flush = async () => {
    if (!statements.length) return;
    const results = await db.batch(statements);
    for (const slot of statusSlots) {
      contacted += Number(results[slot]?.meta?.changes) || 0;
    }
    statements = [];
    statusSlots = [];
  };

  for (const update of updates) {
    for (const send of update.newSends) {
      // The SEND_NOTE_PREFIX is load-bearing, not decoration: /analytics' Email
      // campaigns tab tells a campaign send from a rep's hand-logged email touch
      // by this prefix and nothing else (a touchpoint has no direction and no
      // source column). Keep both branches starting with it.
      const note =
        send.seqNumber === null
          ? `${SEND_NOTE_PREFIX}by ${label}`
          : `${SEND_NOTE_PREFIX}step ${send.seqNumber} of ${label}`;
      statements.push(
        db
          .prepare(
            "INSERT INTO touchpoints (id, contact_id, type, loop, owner, note, created_at) VALUES (?, ?, 'email', ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            update.contactId,
            update.loop,
            // The campaign sends on the contact's owner's behalf; an unassigned
            // contact falls back to whoever pressed Sync, exactly as markAdsSent
            // does for a bulk ad send.
            update.owner || actor,
            note,
            sqliteUTC(send.sentAt) ?? sqliteUTC(new Date().toISOString())!,
          ),
      );
      touchpoints++;
    }

    if (update.markContacted) {
      statusSlots.push(statements.length);
      statements.push(
        db
          .prepare("UPDATE contacts SET status = ? WHERE id = ? AND status = 'New'")
          .bind(SENT_STATUS, update.contactId),
      );
    }

    statements.push(
      db
        .prepare(
          `UPDATE smartlead_leads SET emailed_steps = ?, last_emailed_at = ?
            WHERE campaign_id = ? AND contact_id = ?`,
        )
        .bind(JSON.stringify(update.allKeys), update.lastSentAt, campaignId, update.contactId),
    );

    if (statements.length >= BATCH) await flush();
  }

  await flush();
  return { touchpoints, contacted };
}

// ---------------------------------------------------------------------------
// Smartlead email events (migration 0022)
// ---------------------------------------------------------------------------
//
// The per-email rows the stats sync used to total and discard. Written page by
// page as they are read, and read back as aggregates by /analytics — never as
// individual rows, which is why nothing here returns an event.

/**
 * Store (or refresh) one page of email events.
 *
 * An upsert rather than an INSERT OR IGNORE, unlike every other idempotent write
 * in this file: those record that something HAPPENED and can never change, while
 * an email sent yesterday and opened this morning legitimately comes back with a
 * new open_time. `stats_id` is Smartlead's own key, so the upsert can only ever
 * refresh the same email.
 *
 * Flushed in fixed-size batches for the reason recordContactSends gives: a batch
 * is atomic, and a failure mid-sync leaves earlier batches applied — which is
 * safe here precisely because re-reading the same rows rewrites the same keys.
 */
export async function upsertEmailEvents(
  db: D1Database,
  events: EmailEvent[],
  syncedAt: string,
): Promise<number> {
  const BATCH = 50;
  let written = 0;
  let statements: D1PreparedStatement[] = [];

  const flush = async () => {
    if (!statements.length) return;
    await db.batch(statements);
    statements = [];
  };

  for (const e of events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO smartlead_email_events
             (stats_id, campaign_id, lead_email, sequence_number, sent_at, opened_at,
              clicked_at, replied_at, open_count, click_count, lead_category,
              is_positive, is_bounced, is_unsubscribed, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(stats_id) DO UPDATE SET
             campaign_id = excluded.campaign_id,
             lead_email = excluded.lead_email,
             sequence_number = excluded.sequence_number,
             sent_at = excluded.sent_at,
             opened_at = excluded.opened_at,
             clicked_at = excluded.clicked_at,
             replied_at = excluded.replied_at,
             open_count = excluded.open_count,
             click_count = excluded.click_count,
             lead_category = excluded.lead_category,
             is_positive = excluded.is_positive,
             is_bounced = excluded.is_bounced,
             is_unsubscribed = excluded.is_unsubscribed,
             synced_at = excluded.synced_at`,
        )
        .bind(
          e.statsId,
          e.campaignId,
          e.leadEmail,
          e.sequenceNumber,
          e.sentAt,
          e.openedAt,
          e.clickedAt,
          e.repliedAt,
          e.openCount,
          e.clickCount,
          e.leadCategory,
          e.isPositive ? 1 : 0,
          e.isBounced ? 1 : 0,
          e.isUnsubscribed ? 1 : 0,
          syncedAt,
        ),
    );
    written++;
    if (statements.length >= BATCH) await flush();
  }

  await flush();
  return written;
}

/** Aggregates for one campaign, all counted as UNIQUE LEADS — see below. */
export type CampaignEventTotals = {
  emails: number;
  leads: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  positive: number;
  bounced: number;
  unsubscribed: number;
};

export type CampaignStepTotals = {
  sequenceNumber: number;
  emails: number;
  opened: number;
  clicked: number;
  replied: number;
};

/** One UTC day's volume, keyed by the `YYYY-MM-DD` prefix of the timestamp. */
export type CampaignDayTotals = { day: string; sent: number; opened: number; clicked: number };

export type CampaignEventStats = {
  totals: CampaignEventTotals;
  steps: CampaignStepTotals[];
  days: CampaignDayTotals[];
  lastSyncedAt: string | null;
};

/**
 * Every /analytics figure that comes from the event table, for one campaign.
 *
 * COUNT(DISTINCT lead_email) throughout the headline totals, never COUNT(*).
 * Smartlead's own UI reports unique engagement — one lead who opened eight times
 * is one open — and `is_positive` is a property of the LEAD repeated on each of
 * their rows, so counting rows would report a lead who received four emails as
 * four positive replies. The per-step table below is the one place rows are
 * counted directly, because there one row IS one email of that step.
 *
 * Bucketing is `substr(<ts>, 1, 10)`, the UTC date prefix of Smartlead's ISO
 * timestamps. That has to agree with buildAnalyticsLabels(), which builds its
 * axis from UTC midnights — change one and change the other.
 */
export async function readCampaignEventStats(
  db: D1Database,
  campaignId: string,
  days: number,
): Promise<CampaignEventStats | null> {
  const [totalsRow, stepsRes, daysRes] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS emails,
                COUNT(DISTINCT lead_email) AS leads,
                COUNT(DISTINCT CASE WHEN sent_at IS NOT NULL THEN lead_email END) AS sent,
                COUNT(DISTINCT CASE WHEN opened_at IS NOT NULL THEN lead_email END) AS opened,
                COUNT(DISTINCT CASE WHEN clicked_at IS NOT NULL THEN lead_email END) AS clicked,
                COUNT(DISTINCT CASE WHEN replied_at IS NOT NULL THEN lead_email END) AS replied,
                COUNT(DISTINCT CASE WHEN is_positive = 1 THEN lead_email END) AS positive,
                COUNT(DISTINCT CASE WHEN is_bounced = 1 THEN lead_email END) AS bounced,
                COUNT(DISTINCT CASE WHEN is_unsubscribed = 1 THEN lead_email END) AS unsubscribed,
                MAX(synced_at) AS last_synced_at
           FROM smartlead_email_events
          WHERE campaign_id = ?`,
      )
      .bind(campaignId)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT sequence_number,
                COUNT(*) AS emails,
                SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
                SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
           FROM smartlead_email_events
          WHERE campaign_id = ? AND sent_at IS NOT NULL AND sequence_number IS NOT NULL
          GROUP BY sequence_number
          ORDER BY sequence_number ASC`,
      )
      .bind(campaignId)
      .all<Record<string, unknown>>(),
    // One row per (day, series) rather than three queries: the three timestamps
    // sit on the same row but a given row belongs to a different day for each,
    // so they cannot share a GROUP BY. UNION ALL and fold in JS.
    //
    // The campaign id is bound three times as three plain `?` rather than once as
    // a repeated `?1`. Numbered parameters are valid SQLite, but every other
    // statement in this file uses positional ones and D1's driver is the layer
    // that would have to agree — binding the value again costs nothing and
    // removes the question.
    db
      .prepare(
        `SELECT substr(sent_at, 1, 10) AS day, 'sent' AS kind, COUNT(*) AS n
           FROM smartlead_email_events
          WHERE campaign_id = ? AND sent_at IS NOT NULL
          GROUP BY day
         UNION ALL
         SELECT substr(opened_at, 1, 10) AS day, 'opened' AS kind, COUNT(*) AS n
           FROM smartlead_email_events
          WHERE campaign_id = ? AND opened_at IS NOT NULL
          GROUP BY day
         UNION ALL
         SELECT substr(clicked_at, 1, 10) AS day, 'clicked' AS kind, COUNT(*) AS n
           FROM smartlead_email_events
          WHERE campaign_id = ? AND clicked_at IS NOT NULL
          GROUP BY day
          ORDER BY day ASC`,
      )
      .bind(campaignId, campaignId, campaignId)
      .all<{ day: string; kind: string; n: number }>(),
  ]);

  const num = (raw: unknown) => Number(raw) || 0;
  const emails = num(totalsRow?.emails);
  // No rows means this campaign has never been synced since migration 0022, which
  // the caller must be able to tell from "synced and genuinely empty" — a zero
  // would render as a campaign that has sent nothing.
  if (!emails) return null;

  const byDay = new Map<string, CampaignDayTotals>();
  for (const row of daysRes.results ?? []) {
    const day = String(row.day ?? "");
    if (!day) continue;
    const entry = byDay.get(day) ?? { day, sent: 0, opened: 0, clicked: 0 };
    if (row.kind === "sent") entry.sent = num(row.n);
    else if (row.kind === "opened") entry.opened = num(row.n);
    else if (row.kind === "clicked") entry.clicked = num(row.n);
    byDay.set(day, entry);
  }

  // Trimmed to the window the page draws. Sorted so the caller can index it by
  // label without re-sorting, and `days` is a parameter rather than a constant
  // so the axis length stays owned by buildAnalyticsLabels().
  const window = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-days);

  return {
    totals: {
      emails,
      leads: num(totalsRow?.leads),
      sent: num(totalsRow?.sent),
      opened: num(totalsRow?.opened),
      clicked: num(totalsRow?.clicked),
      replied: num(totalsRow?.replied),
      positive: num(totalsRow?.positive),
      bounced: num(totalsRow?.bounced),
      unsubscribed: num(totalsRow?.unsubscribed),
    },
    steps: (stepsRes.results ?? []).map((row) => ({
      sequenceNumber: num(row.sequence_number),
      emails: num(row.emails),
      opened: num(row.opened),
      clicked: num(row.clicked),
      replied: num(row.replied),
    })),
    days: window,
    lastSyncedAt: (totalsRow?.last_synced_at as string | null) ?? null,
  };
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
  phone: string | null;
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

const PROSPECT_COLS = `id, run_id, position, name, company, title, email, phone, linkedin,
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
    phone: row.phone,
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
 * This viewer's run that is still in flight, or null.
 *
 * Checked before every start, because an Origami agent does one run at a time
 * and the org's concurrent-run pool is as small as ONE on a starter plan. Losing
 * that race costs a 429 and a confusing error; catching it here costs a read.
 *
 * Keyed on OUR stage rather than Origami's status, for the reason threadPayload
 * gives: a run can be `completed` upstream and still owe us the `reading` step.
 *
 * Returns the row rather than a boolean so the caller can tell a live run from
 * an abandoned one and say which run is in the way — a bare `true` left a stuck
 * run blocking every future start with no way to see or cancel it.
 */
export async function findRunningProspectRun(
  db: D1Database,
  viewerEmail: string,
): Promise<StoredProspectRun | null> {
  const row = await db
    .prepare(
      `SELECT ${RUN_COLS} FROM prospect_runs
        WHERE created_by = ? AND stage NOT IN ('ready', 'failed')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(viewerEmail)
    .first<ProspectRunRow>();
  return row ? toStoredRun(row) : null;
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
             (id, run_id, position, name, company, title, email, phone, linkedin, location,
              source_url, email_confidence, dedupe, existing_contact_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          runId,
          index,
          row.name,
          row.company,
          row.title,
          row.email,
          row.phone,
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

// --- Companies and deals ---------------------------------------------------
// See migrations/0017 and 0018. The short version: `contacts.company` is a
// string somebody typed, so it cannot be an identity, and a deal needs one.

type CompanyRow = { id: string; name: string; normalized_name: string };

const COMPANY_COLS = "id, name, normalized_name";

function toCompany(row: CompanyRow): Company {
  return { id: row.id, name: row.name, normalizedName: row.normalized_name };
}

/**
 * The company row for `name`, creating it only if no row already matches.
 *
 * Look-up-then-insert rather than an unconditional insert, because the whole
 * point of the table is that "Halcyon Labs", "halcyon labs" and "Halcyon  Labs"
 * are one company. Matching is on `normalizeName` from app/crm/data.ts — the
 * SAME function migrations/0019 reproduces in SQL for the historical backfill,
 * which is what makes a contact imported today land on the company its
 * colleagues were backfilled onto rather than minting a near-duplicate.
 *
 * NOT fuzzy, deliberately. "Halcyon Labs" and "Halcyon Labs Inc" stay two
 * companies. Collapsing those needs a similarity threshold, and a threshold that
 * is wrong merges two real customers' pipelines into one — an error nobody can
 * see and nothing can undo. Case and whitespace are typos; a different legal
 * suffix may not be.
 *
 * Returns null for a blank name: a contact with no company is an ordinary row
 * (see migrations/0017), not an error, and must not produce an empty company.
 *
 * The UNIQUE violation retry is not defensive noise — two people importing
 * overlapping CSVs at once is exactly how this table gets its first duplicate,
 * and the constraint is the only thing that can arbitrate. Losing the race means
 * the winner's row is the one everybody gets, which is the correct outcome.
 */
export async function findOrCreateCompanyByName(
  db: D1Database,
  name: string,
): Promise<Company | null> {
  const display = str(name);
  const normalized = normalizeName(display);
  if (!normalized) return null;

  const existing = await db
    .prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE normalized_name = ?`)
    .bind(normalized)
    .first<CompanyRow>();
  if (existing) return toCompany(existing);

  const row: CompanyRow = {
    id: crypto.randomUUID(),
    name: display,
    normalized_name: normalized,
  };
  try {
    await db
      .prepare("INSERT INTO companies (id, name, normalized_name) VALUES (?, ?, ?)")
      .bind(row.id, row.name, row.normalized_name)
      .run();
    return toCompany(row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Somebody else inserted the same company between our SELECT and INSERT.
    const winner = await db
      .prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE normalized_name = ?`)
      .bind(normalized)
      .first<CompanyRow>();
    if (!winner) throw err;
    return toCompany(winner);
  }
}

/**
 * Everyone whose company_id is this company — the "Also at [Company]" block, and
 * the stakeholder picker on the deals board.
 *
 * Keyed on company_id, NOT on the free-text `contacts.company` string. Matching
 * on the string would miss the colleague who typed "halcyon labs" and would
 * quietly include anyone at a different company that happens to share a spelling.
 *
 * Returns the light row shape (no notes, no touchpoints) for the same reason
 * loadDedupeIndex does: this runs to fill a side panel, and pulling every note in
 * the database to render four names would be absurd.
 */
export type CompanyContact = {
  id: string;
  name: string;
  company: string;
  owner: string | null;
  status: string;
  email: string | null;
};

export async function listContactsAtCompany(
  db: D1Database,
  companyId: string,
): Promise<CompanyContact[]> {
  if (!companyId) return [];
  const res = await db
    .prepare(
      `SELECT id, name, company, owner, status, email FROM contacts
        WHERE company_id = ? ORDER BY created_at DESC`,
    )
    .bind(companyId)
    .all<{
      id: string;
      name: string;
      company: string | null;
      owner: string | null;
      status: string;
      email: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    company: r.company ?? "",
    owner: r.owner ?? null,
    status: r.status,
    email: r.email ?? null,
  }));
}

type DealRow = {
  id: string;
  company_id: string;
  company_name: string;
  stage: string;
  value: number | null;
  expected_close_date: string | null;
  created_at: string;
  closed_at: string | null;
};

type DealContactRow = {
  deal_id: string;
  contact_id: string;
  role: string;
  name: string;
  owner: string | null;
  status: string;
  email: string | null;
};

// The company name is joined in rather than stored on the deal: every deal view
// renders it, and a company renamed in one place must not leave stale copies.
const DEAL_SELECT = `SELECT d.id, d.company_id, co.name AS company_name, d.stage, d.value,
         d.expected_close_date, d.created_at, d.closed_at
    FROM deals d JOIN companies co ON co.id = d.company_id`;

const DEAL_CONTACT_SELECT = `SELECT dc.deal_id, dc.contact_id, dc.role,
         c.name, c.owner, c.status, c.email
    FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id`;

function toStakeholder(row: DealContactRow): DealStakeholder {
  return {
    contactId: row.contact_id,
    role: row.role === "secondary" ? "secondary" : "primary",
    name: row.name,
    owner: row.owner ?? null,
    status: row.status,
    email: row.email ?? null,
  };
}

/**
 * Shape a deal row plus whichever of its two stakeholder slots are filled.
 *
 * `expectedCloseLabel` is computed HERE, server-side, for the same reason
 * listContacts precomputes followUpDateLabel: no `Date` may run in the render
 * path or SSR and hydration can disagree.
 */
function toDeal(row: DealRow, stakeholders: DealContactRow[]): Deal {
  const filled = stakeholders.map(toStakeholder);
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    stage: row.stage,
    value: row.value === null || row.value === undefined ? null : Number(row.value),
    expectedCloseDate: row.expected_close_date ?? null,
    expectedCloseLabel: row.expected_close_date
      ? dateLabel(Date.parse(row.expected_close_date))
      : null,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? null,
    primary: filled.find((s) => s.role === "primary") ?? null,
    secondary: filled.find((s) => s.role === "secondary") ?? null,
  };
}

/** Stitch stakeholder rows onto their deals in one pass. */
function assembleDeals(dealRows: DealRow[], contactRows: DealContactRow[]): Deal[] {
  const byDeal = new Map<string, DealContactRow[]>();
  for (const r of contactRows) {
    const list = byDeal.get(r.deal_id) ?? [];
    list.push(r);
    byDeal.set(r.deal_id, list);
  }
  return dealRows.map((d) => toDeal(d, byDeal.get(d.id) ?? []));
}

/**
 * Every deal, newest first, with both stakeholder slots resolved.
 *
 * Two queries and a stitch rather than one join with duplicated deal columns —
 * the same shape listContacts uses for notes and touchpoints. The stakeholder
 * table is bounded at two rows per deal by construction (migrations/0018), so
 * the second read is small by definition.
 */
export async function listDeals(db: D1Database): Promise<Deal[]> {
  const [dealsRes, contactsRes] = await Promise.all([
    db.prepare(`${DEAL_SELECT} ORDER BY d.created_at DESC`).all<DealRow>(),
    db.prepare(DEAL_CONTACT_SELECT).all<DealContactRow>(),
  ]);
  return assembleDeals(dealsRes.results ?? [], contactsRes.results ?? []);
}

/** The deals at one company — the "Also at [Company]" block's other half. */
export async function listDealsForCompany(db: D1Database, companyId: string): Promise<Deal[]> {
  if (!companyId) return [];
  const dealsRes = await db
    .prepare(`${DEAL_SELECT} WHERE d.company_id = ? ORDER BY d.created_at DESC`)
    .bind(companyId)
    .all<DealRow>();
  const rows = dealsRes.results ?? [];
  if (!rows.length) return [];
  const contactsRes = await db
    .prepare(`${DEAL_CONTACT_SELECT} WHERE dc.deal_id IN (${rows.map(() => "?").join(", ")})`)
    .bind(...rows.map((r) => r.id))
    .all<DealContactRow>();
  return assembleDeals(rows, contactsRes.results ?? []);
}

/** One deal with both stakeholder slots resolved, or null if the id is unknown. */
export async function getDealWithContacts(db: D1Database, dealId: string): Promise<Deal | null> {
  if (!dealId) return null;
  const row = await db.prepare(`${DEAL_SELECT} WHERE d.id = ?`).bind(dealId).first<DealRow>();
  if (!row) return null;
  const contactsRes = await db
    .prepare(`${DEAL_CONTACT_SELECT} WHERE dc.deal_id = ?`)
    .bind(dealId)
    .all<DealContactRow>();
  return toDeal(row, contactsRes.results ?? []);
}

export type NewDealInput = {
  /** Free text as typed. Resolved through findOrCreateCompanyByName. */
  companyName: string;
  stage?: string;
  value?: number | null;
  expectedCloseDate?: string | null;
  /** Optional — a deal may be created before anyone knows who the champion is. */
  primaryContactId?: string | null;
};

export type CreateDealResult = { ok: true; dealId: string } | { ok: false; error: string };

/** Whether adding/removing a stakeholder succeeded, with a sentence if it did not. */
export type StakeholderResult = { ok: true } | { ok: false; error: string };

/**
 * Create a deal, resolving (or creating) its company on the way in.
 *
 * The company is resolved rather than passed as an id because the form the user
 * fills in has a company NAME on it. Routing that through
 * findOrCreateCompanyByName is what makes a second deal typed as "halcyon labs"
 * land on the same company as the first one typed as "Halcyon Labs" — which is
 * the entire reason the table exists.
 *
 * The optional primary stakeholder is written in the SAME batch as the deal, so
 * a failure to attach the contact cannot leave a company with a stakeholder-less
 * deal nobody meant to create.
 */
export async function createDeal(db: D1Database, input: NewDealInput): Promise<CreateDealResult> {
  const company = await findOrCreateCompanyByName(db, input.companyName);
  if (!company) return { ok: false, error: "A deal needs a company name." };

  const dealId = crypto.randomUUID();
  const stage = str(input.stage) || DEAL_STAGES[0].id;
  const value =
    input.value === null || input.value === undefined || !Number.isFinite(input.value)
      ? null
      : Math.round(input.value);
  const expectedClose = str(input.expectedCloseDate) || null;
  // A deal created directly into Won/Lost is closed the moment it exists.
  const closedAt = isClosedDealStage(stage) ? new Date().toISOString() : null;

  const statements = [
    db
      .prepare(
        `INSERT INTO deals (id, company_id, stage, value, expected_close_date, closed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(dealId, company.id, stage, value, expectedClose, closedAt),
  ];

  const primaryId = str(input.primaryContactId);
  if (primaryId) {
    statements.push(
      db
        .prepare("INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES (?, ?, 'primary')")
        .bind(dealId, primaryId),
    );
  }

  await db.batch(statements);
  return { ok: true, dealId };
}

/**
 * Move a deal to a stage, maintaining `closed_at` on the way.
 *
 * Entering Won/Lost stamps the close date; LEAVING one clears it again, so a
 * deal reopened after a premature "Lost" does not keep a close date that is no
 * longer true. Same instinct as updateContactStatus clearing `dead_reason` when
 * a contact moves off Dead.
 *
 * `closed_at` is written as a full ISO string from JS rather than via
 * datetime('now'), because unlike `created_at` it is read back — SQLite's
 * default emits no timezone designator and would be parsed as local time. This
 * is the rule migrations/0009 states.
 *
 * Nothing here touches any contact's `status`. A deal reaching Won does NOT walk
 * its stakeholders to Won: the two axes are independent (see migrations/0018),
 * and a person's engagement marker is theirs.
 */
export async function updateDealStage(
  db: D1Database,
  dealId: string,
  stage: string,
): Promise<void> {
  const closing = isClosedDealStage(stage);
  await db
    .prepare(
      // All placeholders are bare `?`. Mixing them with numbered `?1`/`?2`
      // silently renumbers the rest — the `?1` that was meant to be the closing
      // flag resolves to `stage` instead.
      `UPDATE deals
          SET stage = ?,
              closed_at = CASE
                WHEN ? = 0 THEN NULL
                WHEN closed_at IS NULL THEN ?
                ELSE closed_at
              END
        WHERE id = ?`,
    )
    .bind(stage, closing ? 1 : 0, new Date().toISOString(), dealId)
    .run();
}

/**
 * Attach a contact to a deal in one of its two slots.
 *
 * REFUSES rather than overwrites when the slot is taken. Silently replacing the
 * primary would mean the person who has been running the relationship vanishes
 * from the deal because somebody picked the wrong dropdown — an edit with no
 * undo and no trace. The caller gets a sentence naming who is already there.
 *
 * This is the code-level backstop, not the guarantee. UNIQUE(deal_id, role) in
 * migrations/0018 is the guarantee: these checks and the INSERT are separate
 * statements, so two writers racing can both pass the check, and the constraint
 * is what arbitrates. The unique-violation branch below turns that loss back
 * into the same sentence, so a race and a plain double-click read identically.
 */
export async function addContactToDeal(
  db: D1Database,
  dealId: string,
  contactId: string,
  role: DealRole,
): Promise<StakeholderResult> {
  if (!dealId || !contactId) return { ok: false, error: "Pick a contact to add." };

  const [deal, contact, occupants] = await Promise.all([
    db.prepare("SELECT id FROM deals WHERE id = ?").bind(dealId).first<{ id: string }>(),
    db
      .prepare("SELECT id, name FROM contacts WHERE id = ?")
      .bind(contactId)
      .first<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT dc.contact_id, dc.role, c.name FROM deal_contacts dc
          JOIN contacts c ON c.id = dc.contact_id WHERE dc.deal_id = ?`,
      )
      .bind(dealId)
      .all<{ contact_id: string; role: string; name: string }>(),
  ]);

  if (!deal) return { ok: false, error: "That deal no longer exists." };
  if (!contact) return { ok: false, error: "That contact no longer exists." };

  const filled = occupants.results ?? [];
  const inRole = filled.find((r) => r.role === role);
  if (inRole) {
    return {
      ok: false,
      error: `This deal already has a ${role} stakeholder (${inRole.name}). Remove them first, or add ${contact.name} to the other slot.`,
    };
  }
  const already = filled.find((r) => r.contact_id === contactId);
  if (already) {
    return {
      ok: false,
      error: `${contact.name} is already the ${already.role} stakeholder on this deal.`,
    };
  }

  try {
    await db
      .prepare("INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES (?, ?, ?)")
      .bind(dealId, contactId, role)
      .run();
  } catch (err) {
    // Lost a race against another writer filling the same slot. The constraint
    // held, which is the point; report it the way the pre-check would have.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error: `This deal already has a ${role} stakeholder. Reload to see who.`,
      };
    }
    throw err;
  }
  return { ok: true };
}

/**
 * Detach a contact from a deal.
 *
 * Deletes only the link. The CONTACT is untouched — not deleted, not restatused,
 * not stripped of its company. Someone removed from a deal is still a contact in
 * the book, and still at the same company.
 */
export async function removeContactFromDeal(
  db: D1Database,
  dealId: string,
  contactId: string,
): Promise<StakeholderResult> {
  if (!dealId || !contactId) return { ok: false, error: "Pick a stakeholder to remove." };
  await db
    .prepare("DELETE FROM deal_contacts WHERE deal_id = ? AND contact_id = ?")
    .bind(dealId, contactId)
    .run();
  // Deliberately not reporting "no such stakeholder" when the delete matched
  // nothing: the row already being gone — someone else's removal, or a double
  // submit — is the state the caller asked for, so it is a success.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Unipile replies
// ---------------------------------------------------------------------------
//
// The inbound half of the CRM (migrations/0021). Two concerns live here and they
// are deliberately separate: `unipile_accounts` is sync bookkeeping — a
// watermark per connected account, so a re-press reads forward rather than
// re-reading a mailbox — and `contact_replies` is history, which is why deleting
// a watermark row never touches a reply.
//
// The account LIST is not stored at all. /settings reads it live from Unipile,
// for the reason /smartlead's SENDERS section reads its mailboxes live: a
// mirrored copy renders "connected" for a LinkedIn session that expired an hour
// ago, and that is the single fact an operator needs told truthfully.

/** One connected account's sync state, as /settings renders it. */
export type UnipileSyncState = {
  accountId: string;
  provider: string;
  displayName: string;
  /** Raw ISO watermark. Also the `after` parameter for the next read. */
  lastSyncedAt: string | null;
  /** "Jul 20"-style label, precomputed so no Date runs during render. */
  lastSyncedLabel: string | null;
  lastResult: string | null;
};

type UnipileAccountRow = {
  account_id: string;
  provider: string;
  display_name: string;
  last_synced_at: string | null;
  last_result: string | null;
};

/** Every account this CRM has synced, keyed by Unipile account id. */
export async function getUnipileSyncState(
  db: D1Database,
): Promise<Record<string, UnipileSyncState>> {
  const res = await db
    .prepare(
      "SELECT account_id, provider, display_name, last_synced_at, last_result FROM unipile_accounts",
    )
    .all<UnipileAccountRow>();

  const out: Record<string, UnipileSyncState> = {};
  for (const row of res.results ?? []) {
    const ms = row.last_synced_at ? Date.parse(row.last_synced_at) : NaN;
    out[row.account_id] = {
      accountId: row.account_id,
      provider: row.provider ?? "",
      displayName: row.display_name ?? "",
      lastSyncedAt: row.last_synced_at ?? null,
      lastSyncedLabel: Number.isNaN(ms) ? null : dateLabel(ms),
      lastResult: row.last_result ?? null,
    };
  }
  return out;
}

/**
 * Move one account's watermark forward and record what the sync did.
 *
 * NEVER BACKWARDS. `MAX(...)` on the stored value rather than a plain assignment,
 * because two operators can press Sync at the same moment: the one that finishes
 * second read an older page and would otherwise rewind the watermark, causing
 * the next sync to re-read (and the unique index to silently discard) messages
 * that were already handled. The comparison is textual, which is chronological
 * for the one ISO-UTC format Unipile emits — the same argument planReplies()
 * makes about ordering.
 *
 * `watermark` is null when a sync found nothing new, and the MAX then keeps
 * whatever was there. That is not a no-op: `last_result` still updates, so the
 * page can say "no new replies" and mean it.
 */
export async function stampUnipileSync(
  db: D1Database,
  accountId: string,
  input: { provider: string; displayName: string; watermark: string | null; result: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO unipile_accounts (account_id, provider, display_name, last_synced_at, last_result)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(account_id) DO UPDATE SET
         provider = ?2,
         display_name = ?3,
         last_synced_at = NULLIF(
           MAX(
             COALESCE(unipile_accounts.last_synced_at, ''),
             COALESCE(?4, '')
           ),
           ''
         ),
         last_result = ?5`,
    )
    .bind(
      accountId,
      str(input.provider),
      str(input.displayName),
      input.watermark,
      input.result.slice(0, 300),
    )
    .run();
}

/**
 * Forget an account's watermark.
 *
 * Called when the account is disconnected at Unipile, and only then. The replies
 * it observed are left alone — a reply that happened is a fact about the
 * contact, not about the mailbox that saw it.
 */
export async function forgetUnipileAccount(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("DELETE FROM unipile_accounts WHERE account_id = ?").bind(accountId).run();
}

/**
 * Clear one account's watermark so the next sync re-reads the recent window.
 *
 * The deliberate rewind that stampUnipileSync's MAX() refuses to do by accident,
 * and the escape hatch for the one way a sync can get stuck: an account so far
 * behind that every sync truncates, which (see AccountRead.truncated in
 * unipile-sync.server.ts) leaves the watermark where it is so no message is
 * stepped over. Pressing this says "skip the backlog, start from recent" — a
 * decision an operator can make and the sync never can.
 *
 * Safe to press at any time: every reply it re-reads is refused by the unique
 * index, so the cost is a wasted read rather than a duplicated timeline.
 */
export async function resetUnipileWatermark(db: D1Database, accountId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE unipile_accounts SET last_synced_at = NULL, last_result = ? WHERE account_id = ?",
    )
    .bind("Watermark reset — the next sync re-reads the recent window.", accountId)
    .run();
}

type ReplyRow = {
  id: string;
  contact_id: string;
  channel: string;
  subject: string | null;
  snippet: string;
  sender_name: string;
  received_at: string;
  name: string;
  company: string | null;
  owner: string | null;
};

/**
 * The unread replies the "New replies" strip shows, newest first.
 *
 * Capped, because the strip is a horizontal row and an inbox that has gone
 * unattended for a month is not something a contacts page should try to render
 * in full. The cap is applied in SQL rather than after the join, so a large
 * backlog still costs one bounded read.
 *
 * Joined to `contacts` with an INNER join deliberately: a reply whose contact
 * was deleted has nowhere to click through to. deleteContacts() removes them
 * anyway, so this is a guard against a row predating that cascade rather than an
 * expected case.
 */
export async function listUnreadReplies(
  db: D1Database,
  now: number,
  limit = 40,
): Promise<ReplyCard[]> {
  const res = await db
    .prepare(
      `SELECT r.id, r.contact_id, r.channel, r.subject, r.snippet, r.sender_name, r.received_at,
              c.name, c.company, c.owner
         FROM contact_replies r
         JOIN contacts c ON c.id = r.contact_id
        WHERE r.read_at IS NULL
        ORDER BY r.received_at DESC
        LIMIT ?`,
    )
    .bind(Math.max(0, Math.floor(limit)))
    .all<ReplyRow>();

  return (res.results ?? []).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName: row.name,
    company: row.company ?? "",
    channel: row.channel,
    subject: row.subject,
    snippet: row.snippet ?? "",
    senderName: row.sender_name ?? "",
    owner: row.owner ?? null,
    daysAgo: dayDiff(Date.parse(row.received_at), now),
  }));
}

/**
 * How many unread replies there are in total.
 *
 * Separate from listUnreadReplies' length because that read is capped: /settings
 * reports the true backlog, and the strip's own count would under-report it the
 * moment someone left the inbox alone for a week.
 */
export async function countUnreadReplies(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM contact_replies WHERE read_at IS NULL")
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * Mark replies read. With no ids, marks every unread reply read.
 *
 * `read_at IS NULL` is carried on both forms so the count returned is the number
 * that actually changed rather than the number addressed — two people clearing
 * the strip at once should not both report clearing twelve.
 */
export async function markRepliesRead(db: D1Database, ids?: string[]): Promise<number> {
  const stamp = new Date().toISOString();

  if (!ids) {
    const res = await db
      .prepare("UPDATE contact_replies SET read_at = ? WHERE read_at IS NULL")
      .bind(stamp)
      .run();
    return res.meta?.changes ?? 0;
  }

  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (!unique.length) return 0;

  const CHUNK = 50;
  let changed = 0;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const res = await db
      .prepare(
        `UPDATE contact_replies SET read_at = ?
          WHERE read_at IS NULL AND id IN (${placeholders})`,
      )
      .bind(stamp, ...chunk)
      .run();
    changed += res.meta?.changes ?? 0;
  }
  return changed;
}

/** What one matched reply asks to be written. Mirrors MatchedReply, plus the loop. */
export type ReplyWrite = {
  contactId: string;
  channel: string;
  accountId: string;
  providerMessageId: string;
  threadId: string | null;
  subject: string | null;
  snippet: string;
  senderName: string;
  senderIdentifier: string;
  /** Which rule matched it: see ReplyMatchRule in ../crm/unipile-map. */
  matchedOn: string;
  receivedAt: string;
};

/**
 * Store matched replies, log each as a touchpoint, and promote the contact.
 *
 * THREE WRITES PER REPLY, AND ONLY THE FIRST IS THE GUARD. The INSERT OR IGNORE
 * against the unique (account_id, provider_message_id) index is what makes
 * pressing Sync twice a no-op — but an ignored insert is still a successful
 * statement, so a blind follow-up would write the touchpoint and re-promote the
 * contact anyway and a re-press would double the timeline. That is why this
 * reads back the ids it actually inserted (`RETURNING id`) and writes the other
 * two only for those. It is the only way to learn what an INSERT OR IGNORE
 * really did.
 *
 * The status UPDATE carries its own `status IN (...)` guard rather than trusting
 * the snapshot the plan was built from, exactly as recordContactSends() does: a
 * sync is long enough for someone to move a contact in the CRM while it runs,
 * and the WHERE clause is what makes this write lose that race instead of win
 * it. The promoted count comes from `meta.changes`, so it reports what moved.
 *
 * Batches are fixed-size rather than per-reply for the reason recordContactSends
 * gives — a reply contributes two batched statements, so chunking by reply sizes
 * the batch on a number nobody controls. A batch is atomic, so a mid-sync
 * failure leaves earlier batches applied; that is safe here because the reply
 * rows written before them are what stop the work being repeated.
 */
export async function recordReplies(
  db: D1Database,
  writes: ReplyWrite[],
  actor: string,
  ownerByContact: Map<string, string | null>,
  loopByContact: Map<string, number>,
): Promise<{ stored: number; promoted: number }> {
  if (!writes.length) return { stored: 0, promoted: 0 };

  const CHUNK = 40;
  let stored = 0;
  let promoted = 0;

  for (let i = 0; i < writes.length; i += CHUNK) {
    const chunk = writes.slice(i, i + CHUNK);

    // Inserted one at a time rather than as a batch, because the RETURNING row
    // is the only signal that separates "stored" from "already had it", and it
    // has to be attributed back to the specific reply that produced it.
    const accepted: ReplyWrite[] = [];
    for (const w of chunk) {
      const row = await db
        .prepare(
          `INSERT OR IGNORE INTO contact_replies
             (id, contact_id, channel, account_id, provider_message_id, thread_id,
              subject, snippet, sender_name, sender_identifier, matched_on, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
        )
        .bind(
          crypto.randomUUID(),
          w.contactId,
          w.channel,
          w.accountId,
          w.providerMessageId,
          w.threadId,
          w.subject,
          w.snippet.slice(0, 400),
          w.senderName.slice(0, 200),
          w.senderIdentifier.slice(0, 320),
          w.matchedOn,
          w.receivedAt,
        )
        .first<{ id: string }>();
      if (row?.id) accepted.push(w);
    }

    if (!accepted.length) continue;
    stored += accepted.length;

    const statements: D1PreparedStatement[] = [];
    const statusSlots: number[] = [];

    for (const w of accepted) {
      // The reply joins the timeline as a touchpoint of its own channel, so the
      // contacts table's "last touch" column and the analytics channel mix both
      // pick it up with no special case. How it was matched is deliberately not
      // in the note: that is diagnostic plumbing, and the timeline is read by
      // people asking what happened, not how it was attributed.
      const label = w.senderName ? ` from ${w.senderName.slice(0, 60)}` : "";
      statements.push(
        db
          .prepare(
            "INSERT INTO touchpoints (id, contact_id, type, loop, owner, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            w.contactId,
            // Only ever 'email' or 'linkedin'. The CHECK on contact_replies.channel
            // and channelForProvider() are the two things that guarantee it.
            w.channel,
            loopByContact.get(w.contactId) ?? 1,
            // The reply is the contact's owner's to answer; an unassigned contact
            // falls back to whoever pressed Sync, exactly as recordContactSends()
            // and markAdsSent() do.
            ownerByContact.get(w.contactId) || actor,
            // Same contract as the send prefix above — see SEND_NOTE_PREFIX.
            `${REPLY_NOTE_PREFIX}${label}`,
            sqliteUTC(w.receivedAt) ?? sqliteUTC(new Date().toISOString())!,
          ),
      );

      statusSlots.push(statements.length);
      statements.push(
        db
          .prepare(
            `UPDATE contacts SET status = ?
              WHERE id = ? AND status IN (${REPLY_PROMOTES_FROM.map(() => "?").join(", ")})`,
          )
          .bind(REPLY_STATUS, w.contactId, ...REPLY_PROMOTES_FROM),
      );
    }

    const results = await db.batch(statements);
    for (const slot of statusSlots) {
      promoted += Number(results[slot]?.meta?.changes) || 0;
    }
  }

  return { stored, promoted };
}
