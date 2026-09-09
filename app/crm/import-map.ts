// Reading a contact export: which column is which, and how a row becomes a
// contact.
//
// Pure and isomorphic, the same contract as ./views.ts and ./smartlead-map.ts:
// no React, no server imports, no `Date`. It is its own module for the reason
// those are — ./sales-loop-crm.tsx is the UI, and "does this file's third column
// mean Loop or Website" is a question that should be answerable without
// rendering anything.
//
// THE BUG THIS EXISTS TO PREVENT. The importer used to read columns by POSITION
// against a fixed eleven-column shape. Every bought lead export is a different
// shape — a ZoomInfo file carries Website and Job Title after Company — and a
// positional read of one of those does not fail, it succeeds with every field
// shifted: the website lands in the loop, the job title in the owner, and the
// whole row after that is off by two. A silent wrong answer, on the one screen
// whose job is getting people's details right.
//
// So columns are identified by their header name, in any order, and anything
// unrecognised is skipped without moving the columns around it. The positional
// order survives only as the fallback for a headerless paste, which is a shape
// the app has always accepted and which nothing else can disambiguate.

import { OWNERS, STATUSES } from "./data";

/**
 * Every field the importer can fill, and the header names it answers to.
 *
 * Aliases are what makes this work on a file nobody prepared for us: exports
 * disagree about `Company` vs `Organization` and `Job Title` vs `Title`, and the
 * cost of accepting both is one array entry. Order within a list means nothing —
 * these are matched, not ranked.
 */
export const HEADER_ALIASES = {
  name: ["name", "full name"],
  company: ["company", "company name", "organization"],
  website: ["website", "url", "domain"],
  jobTitle: ["job title", "title", "role"],
  loop: ["loop", "loops"],
  owner: ["owner", "assigned to"],
  status: ["status", "stage"],
  source: ["source", "lead source"],
  email: ["email", "email address"],
  phone: ["phone", "phone number", "mobile"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
  category: ["category", "industry"],
  arr: ["arr", "revenue", "annual revenue"],
} as const;

export type ImportField = keyof typeof HEADER_ALIASES;

/** Which column index holds each field. Absent = the file doesn't carry it. */
export type ColumnMap = Partial<Record<ImportField, number>>;

/**
 * alias -> field, flattened once.
 *
 * A null-prototype object, not `{}`: this is indexed by text out of a file, and
 * on a plain object a column headed "constructor" or "toString" resolves to a
 * function rather than undefined — the same trap `ownerAvatar` in ./data.ts
 * documents for OWNERS.
 */
export const HEADER_LOOKUP: Record<string, ImportField> = (() => {
  const out: Record<string, ImportField> = Object.create(null);
  for (const field of Object.keys(HEADER_ALIASES) as ImportField[]) {
    for (const alias of HEADER_ALIASES[field]) out[alias] = field;
  }
  return out;
})();

/**
 * A header cell reduced to the form the alias table is written in.
 *
 * The three substitutions each answer a real file. The BOM is what Excel writes
 * at the start of a UTF-8 CSV, and it rides on the first cell — without
 * stripping it, `Name` never matches and the whole file falls back to positional
 * reading, which is the exact failure this module exists to prevent. Underscores
 * and hyphens cover `job_title` / `job-title` for free. Collapsing runs of
 * whitespace covers the double space in `Job  Title`.
 */
export function normalizeHeader(cell: string): string {
  return cell
    .replace(/^\uFEFF/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The order a headerless file is read in: the eleven columns this importer
 * accepted before headers existed, unchanged.
 *
 * Deliberately NOT extended with website and jobTitle. A file with no header is
 * a file whose shape we are guessing at, and the only defensible guess is the
 * one that was documented — adding two columns to it would re-break every saved
 * workflow in exactly the way described at the top of this section.
 */
export const LEGACY_ORDER: ImportField[] = [
  "name",
  "company",
  "loop",
  "owner",
  "status",
  "source",
  "email",
  "phone",
  "linkedin",
  "category",
  "arr",
];

export const LEGACY_COLUMNS: ColumnMap = Object.fromEntries(
  LEGACY_ORDER.map((field, index) => [field, index]),
);

/**
 * Read a row as a header, reporting how much of it was recognised.
 *
 * `matched` is what the caller decides on, and it is returned rather than
 * thresholded here because "is this a header" and "is this a header we can use"
 * are two different questions with two different answers for the user.
 *
 * First occurrence wins for a duplicated header. A file with two Email columns
 * is already ambiguous; taking the earlier one is arbitrary but stable, and it
 * beats the alternative of the later empty one silently blanking the field.
 */
export function readHeaderRow(cells: string[]): { columns: ColumnMap; matched: number } {
  const columns: ColumnMap = {};
  let matched = 0;
  cells.forEach((cell, index) => {
    const field = HEADER_LOOKUP[normalizeHeader(cell)];
    if (!field) return; // Unrecognised column: ignored, and it shifts nothing,
    matched++; // because every other field carries its own index.
    if (columns[field] === undefined) columns[field] = index;
  });
  return { columns, matched };
}

/**
 * Is this first row labels rather than a contact?
 *
 * Two ways to qualify, and the first is the one that matters: a cell that maps
 * to `name`. No real contact is called "Name" or "Full Name", so that alone is
 * conclusive, and it catches a file whose other twelve columns we have never
 * heard of. Two recognised cells is the second path, for a header that calls the
 * name column something this table doesn't list — which the caller then refuses
 * with a message, rather than reading positionally and corrupting every row.
 */
export function looksLikeHeader(header: { columns: ColumnMap; matched: number }): boolean {
  return header.columns.name !== undefined || header.matched >= 2;
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "," || c === "\t") {
      out.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field.trim());
  return out;
}


// ---------------------------------------------------------------------------
// Rows -> contacts
// ---------------------------------------------------------------------------

/**
 * One contact as the importer submits it.
 *
 * Every field is a string (or the loop array) because this is what gets
 * JSON.stringify'd into the `importContacts` form field and validated on the
 * server by validateContact — which is where lengths, the owner whitelist and
 * the email format are actually enforced. Nothing here rejects a row for being
 * wrong; it only decides what each cell MEANS.
 */
export type ImportedContact = {
  name: string;
  company: string;
  loops: number[];
  owner: string | null;
  status: string;
  source: string;
  email: string;
  phone: string;
  linkedin: string;
  website: string;
  jobTitle: string;
  category: string;
  arr: string;
};

/**
 * Resolve an Owner cell to one of the four people, or nobody.
 *
 * A known name wins outright, case-insensitively, because that is what the cell
 * actually says. The first-letter heuristic below it is the older rule and stays
 * only as a fallback: files in circulation carry bare "T" and "B", and dropping
 * it would silently unassign every row in them.
 *
 * The ORDER is the fix. This used to try the heuristic first, so "Mike"
 * resolved to nobody — no name it recognised starts with an M — and a real
 * export naming a real owner imported unassigned, on every row.
 */
export function parseImportOwner(value: string): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  const known = Object.keys(OWNERS).find((o) => o.toLowerCase() === raw.toLowerCase());
  if (known) return known;
  const lower = raw.toLowerCase();
  if (lower.startsWith("t")) return "Tom";
  if (lower.startsWith("b")) return "Britton";
  return null;
}

/** A Status cell matched against the closed set, defaulting to New. */
export function parseImportStatus(value: string): string {
  const s = (value || "").trim().toLowerCase();
  const hit = STATUSES.find((x) => x.id.toLowerCase() === s);
  return hit ? hit.id : "New";
}

/**
 * A Loop cell read generously: the digit, the word, or the kind of thing a loop
 * is for. `defaultLoop` is what an empty or unreadable cell falls back to, and
 * the caller passes the loop the operator is currently looking at.
 */
export function parseImportLoops(value: string, defaultLoop: number): number[] {
  const s = (value || "").toLowerCase();
  const out: number[] = [];
  if (/\b1\b|loop\s*1|general|outbound/.test(s)) out.push(1);
  if (/\b2\b|loop\s*2|event|blitz|community/.test(s)) out.push(2);
  return out.length ? out : [defaultLoop];
}

/**
 * Turn a table of cells into contacts, deciding first how to read its columns.
 *
 * One implementation for both formats. A .csv arrives as text and is split by
 * splitCsvLine; an .xlsx is turned into the same array-of-rows by SheetJS. By
 * the time either reaches here they are indistinguishable, which is the point —
 * "which column is the email" is answered once.
 *
 * Returns an error rather than throwing, and never a partial success with a
 * silent explanation: a file that cannot be read correctly must say so, because
 * the alternative is the bug in this module's header.
 */
export function buildImportRows(
  table: string[][],
  opts: { defaultLoop: number },
):
  | { ok: true; rows: ImportedContact[]; usedHeader: boolean }
  | { ok: false; error: string } {
  if (!table.length) {
    return { ok: false, error: "Drop a .csv or .xlsx file first." };
  }

  // Header first, positions second. A file that labels its columns is read by
  // those labels in whatever order they appear; only a file with no labels at
  // all falls back to the eleven-column order, where position is the only
  // information there is.
  const header = readHeaderRow(table[0] ?? []);
  const usedHeader = looksLikeHeader(header);
  if (usedHeader && header.columns.name === undefined) {
    // Recognised as labels, but nothing in it says "name". Refused loudly
    // rather than read positionally: a positional read of a labelled file is
    // precisely the silent corruption this module exists to stop.
    return {
      ok: false,
      error:
        "That file has a header row but no Name column. Rename it to “Name” (or “Full Name”) and try again.",
    };
  }
  const columns = usedHeader ? header.columns : LEGACY_COLUMNS;
  const start = usedHeader ? 1 : 0;

  // A field the file doesn't carry reads as empty — never as another column's
  // value, which is the whole difference from the positional version.
  const cell = (cols: string[], field: ImportField) => {
    const index = columns[field];
    return index === undefined ? "" : (cols[index] ?? "").trim();
  };

  const rows: ImportedContact[] = [];
  for (let i = start; i < table.length; i++) {
    const cols = table[i] ?? [];
    const name = cell(cols, "name");
    if (!name) continue;
    const loops = parseImportLoops(cell(cols, "loop"), opts.defaultLoop);
    rows.push({
      name,
      company: cell(cols, "company"),
      loops,
      owner: parseImportOwner(cell(cols, "owner")),
      status: parseImportStatus(cell(cols, "status")),
      // Unchanged behaviour: Source means "which event or community", which is a
      // Loop 2 concept, so a Loop 1 row does not keep one.
      source: loops.includes(2) ? cell(cols, "source") : "",
      email: cell(cols, "email"),
      phone: cell(cols, "phone"),
      linkedin: cell(cols, "linkedin"),
      website: cell(cols, "website"),
      jobTitle: cell(cols, "jobTitle"),
      category: cell(cols, "category"),
      arr: cell(cols, "arr"),
    });
  }

  if (!rows.length) {
    return {
      ok: false,
      error: usedHeader
        ? "Couldn’t read any contacts — every row was missing a name."
        : "Couldn’t read any contacts. Add a header row, or use the order: Name, Company, Loop, Owner, Status, Source, Email, Phone, LinkedIn, Category, ARR",
    };
  }
  return { ok: true, rows, usedHeader };
}
