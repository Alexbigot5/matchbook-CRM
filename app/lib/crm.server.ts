// Server-only data-access layer for the CRM. Persists to Cloudflare D1 and
// converts the stored absolute timestamps into the relative `daysAgo` /
// `followUp` values that app/crm/data.ts and the UI expect. Keeping every date
// calculation here (against a single `now` captured in the loader) is what keeps
// SSR and client hydration deterministic — no `Date` runs in the render path.

import type { Contact, Note } from "../crm/data";

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

/** "Jul 20"-style label, matching the original fmtDate() output. */
function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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
  owner: string | null;
  status: string;
  loops: string;
  follow_up_at: string | null;
  created_at: string;
};

type NoteRow = {
  id: string;
  contact_id: string;
  author: string | null;
  text: string;
  created_at: string;
};

/**
 * Load every contact with its notes, shaped to satisfy the existing `Contact`
 * type. `touches` is always empty (no write path creates touchpoints yet) and
 * `opts` is always `{}`. `now` is the loader's single reference instant.
 */
export async function listContacts(db: D1Database, now: number): Promise<Contact[]> {
  const [contactsRes, notesRes] = await Promise.all([
    db
      .prepare(
        "SELECT id, name, company, owner, status, loops, follow_up_at, created_at FROM contacts ORDER BY created_at DESC",
      )
      .all<ContactRow>(),
    db
      .prepare(
        "SELECT id, contact_id, author, text, created_at FROM notes ORDER BY created_at DESC",
      )
      .all<NoteRow>(),
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

  return (contactsRes.results ?? []).map((row): Contact => {
    let followUp: number | null = null;
    let followUpDateLabel: string | null = null;
    if (row.follow_up_at) {
      const dueMs = Date.parse(row.follow_up_at);
      followUp = -dayDiff(now, dueMs); // due today -> 0, due in 3 days -> -3
      followUpDateLabel = dateLabel(dueMs);
    }
    return {
      id: row.id,
      name: row.name,
      company: row.company ?? "",
      loops: parseLoops(row.loops),
      owner: row.owner ?? null,
      status: row.status,
      touches: [],
      notes: notesByContact.get(row.id) ?? [],
      followUp,
      followUpDateLabel,
      opts: {},
    };
  });
}

export type NewContactInput = {
  name: string;
  company?: string;
  loops?: number[];
  owner?: string | null;
  status?: string;
};

function insertContactStmt(db: D1Database, input: NewContactInput) {
  const name = input.name.trim();
  const followUpAt = new Date().toISOString(); // new contacts are "due today"
  return db
    .prepare(
      "INSERT INTO contacts (id, name, company, owner, status, loops, follow_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      name,
      (input.company || "").trim(),
      input.owner ?? null,
      input.status || "New",
      JSON.stringify(normalizeLoops(input.loops)),
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

export async function updateContactStatus(
  db: D1Database,
  id: string,
  status: string,
): Promise<void> {
  await db
    .prepare("UPDATE contacts SET status = ? WHERE id = ?")
    .bind(status, id)
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
    .bind(crypto.randomUUID(), contactId, author, text.trim())
    .run();
}
