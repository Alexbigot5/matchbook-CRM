// The prospecting agent's model: how a plain-English brief becomes an Origami
// run, how the table that run builds becomes reviewable prospects, and how an
// approved prospect becomes a contact.
//
// Pure and isomorphic, the same contract as smartlead-map.ts, analytics.ts and
// ab.ts: no React, no server imports, and NO `Date`. Every date is resolved in
// the loader against a single `now` and arrives here as an integer or a label,
// which is what keeps SSR and hydration identical.
//
// FOUR NON-OBVIOUS RULES LIVE HERE.
//
//   1. The brief is COMPOSED. What the user types is wrapped with instructions
//      naming the columns we want back, built server-side so the client cannot
//      replace them — the same reason the triggerAgent intent builds its payload
//      from stored data rather than from the form.
//
//   2. Column slugs are NOT known in advance. An Origami agent names its own
//      columns, so mapColumns() resolves whatever it built onto our seven
//      fields, and reports what it could not find rather than rendering blanks.
//
//   3. Email confidence is DERIVED. The v2 API exposes no confidence field, so
//      "verified" means the agent produced a status column saying so, and
//      anything else with a parseable address is "likely". The UI must not
//      imply we verified an address ourselves, because we did not.
//
//   4. Deduped prospects are KEPT, not dropped. Storing them with a reason is
//      what makes "7 already in the CRM" a real number rather than a guess, and
//      it survives re-opening the run.

import { buildNameIndex, normalizeName, type Contact, type NameIndex } from "./data";
import type { ContactFields, EmailConfidence, ProspectFields } from "../lib/validate";

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

/**
 * The columns we ask every run to produce, in the order they read best in the
 * panel. `slug` is what Origami will most likely derive from `label`; the
 * aliases in COLUMN_ALIASES cover it choosing otherwise.
 */
export const REQUESTED_COLUMNS = [
  { field: "name", label: "Full Name", slug: "full-name" },
  { field: "title", label: "Job Title", slug: "job-title" },
  { field: "company", label: "Company", slug: "company" },
  { field: "email", label: "Work Email", slug: "work-email" },
  { field: "emailStatus", label: "Email Status", slug: "email-status" },
  { field: "phone", label: "Phone Number", slug: "phone-number" },
  { field: "linkedin", label: "LinkedIn URL", slug: "linkedin-url" },
  { field: "location", label: "Location", slug: "location" },
  { field: "sourceUrl", label: "Source URL", slug: "source-url" },
] as const;

export type ProspectField = (typeof REQUESTED_COLUMNS)[number]["field"];

/**
 * Wrap the user's brief with the column contract.
 *
 * Without this the agent builds whatever columns it thinks the brief implies,
 * and two runs of the same search come back with different shapes. Naming them
 * makes the slugs predictable; mapColumns() still copes when they aren't.
 *
 * The instruction is appended rather than prepended so the user's own words are
 * what the agent reads first — an agent given a wall of schema boilerplate ahead
 * of a one-line brief tends to optimize for the boilerplate.
 */
export function composeBrief(prompt: string): string {
  const columns = REQUESTED_COLUMNS.map((c) => c.label).join(", ");
  return (
    `${prompt.trim()}\n\n` +
    `Return the results as a table with these columns, using exactly these names: ` +
    `${columns}. ` +
    `"Email Status" should say whether the email address is verified or a guess. ` +
    `"Phone Number" is optional — leave it empty unless you found a real one. ` +
    `"Source URL" should link to where you found the person. ` +
    `Leave a cell empty rather than inventing a value.`
  );
}

/**
 * The example briefs shown on an empty thread. Static, and deliberately shaped
 * like the two loops: one always-on ICP search, one community/event search.
 */
export const EXAMPLE_BRIEFS = [
  "Find ops leads at CPG brands in Denver who went to Expo West",
  "Founders and growth leads in the Newtopia community",
  "RevOps directors at 50-200 person B2B software companies",
] as const;

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * Fallback slugs per field, tried in order after an exact match on the slug we
 * asked for. These are the shapes Origami's agent actually reaches for when it
 * ignores the brief's column names — "ceo-email" in particular is what their own
 * documentation uses as an example enrichment column.
 */
const COLUMN_ALIASES: Record<ProspectField, readonly string[]> = {
  name: ["full-name", "name", "person", "person-name", "contact", "contact-name", "lead"],
  title: ["job-title", "title", "role", "position", "headline"],
  company: ["company", "company-name", "organization", "organisation", "employer", "account"],
  email: ["work-email", "email", "email-address", "ceo-email", "contact-email", "work-email-address"],
  emailStatus: ["email-status", "email-confidence", "email-verification", "email-validity"],
  phone: ["phone-number", "phone", "mobile", "telephone", "tel", "direct-dial", "contact-number"],
  linkedin: ["linkedin-url", "linkedin", "linkedin-profile", "li-url", "profile-url"],
  location: ["location", "city", "region", "geo", "country"],
  sourceUrl: ["source-url", "source", "url", "website", "profile", "link"],
};

/** Which of our fields each table column feeds, plus what we could not find. */
export type ColumnMap = {
  /** field -> the table's slug for it. Absent when the agent produced no such column. */
  bySlug: Partial<Record<ProspectField, string>>;
  /** Fields with no column at all, as human labels, for the panel to report. */
  missing: string[];
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a table's actual columns onto our fields.
 *
 * Three passes, narrowing: exact slug, then alias, then a contains-match on
 * either the slug or the slugified column name. The contains pass is what
 * catches "primary-work-email" or "linkedin-profile-url-verified"; it is last
 * because it is the one that can mis-fire, and a field already claimed by an
 * earlier pass is never overwritten.
 *
 * `sequence` columns are skipped outright — those hold drafted outreach copy,
 * not facts about the person, and one of them matching "email" would put a whole
 * cold email into the email field.
 */
export function mapColumns(columns: { slug?: string; name?: string; kind?: string }[]): ColumnMap {
  const usable = columns
    .filter((c) => c.kind !== "sequence")
    .map((c) => ({
      slug: (c.slug ?? "").trim(),
      nameSlug: slugify(c.name ?? ""),
    }))
    .filter((c) => !!c.slug);

  const bySlug: Partial<Record<ProspectField, string>> = {};
  const taken = new Set<string>();

  const claim = (field: ProspectField, slug: string) => {
    if (bySlug[field] || taken.has(slug)) return;
    bySlug[field] = slug;
    taken.add(slug);
  };

  for (const { field, slug } of REQUESTED_COLUMNS) {
    const hit = usable.find((c) => c.slug === slug || c.nameSlug === slug);
    if (hit) claim(field, hit.slug);
  }

  for (const { field } of REQUESTED_COLUMNS) {
    if (bySlug[field]) continue;
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = usable.find((c) => c.slug === alias || c.nameSlug === alias);
      if (hit) {
        claim(field, hit.slug);
        break;
      }
    }
  }

  for (const { field } of REQUESTED_COLUMNS) {
    if (bySlug[field]) continue;
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = usable.find(
        (c) => !taken.has(c.slug) && (c.slug.includes(alias) || c.nameSlug.includes(alias)),
      );
      if (hit) {
        claim(field, hit.slug);
        break;
      }
    }
  }

  // Only the fields whose absence changes what a human sees are reported.
  // emailStatus, phone and sourceUrl are enrichments on top; their absence
  // degrades gracefully and saying so would just be noise on every run — a
  // phone number in particular is missing from most tables by nature, so
  // reporting it would put a warning on runs that went fine.
  const reportable: ProspectField[] = ["name", "title", "company", "email", "linkedin"];
  const missing = REQUESTED_COLUMNS.filter(
    (c) => reportable.includes(c.field) && !bySlug[c.field],
  ).map((c) => c.label);

  return { bySlug, missing };
}

/** Pull one field out of a flat row, as a trimmed string. */
function cell(row: Record<string, unknown>, slug: string | undefined): string {
  if (!slug) return "";
  const raw = row[slug];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  // A flat cell should be a scalar. An object here means the caller forgot
  // `cells=flat`, or the column is polymorphic after all — either way there is
  // nothing sensible to render, and stringifying it would put "[object Object]"
  // in front of a salesperson.
  return "";
}

/**
 * How much to trust an address.
 *
 * DERIVED. The Origami v2 API has no confidence field, so this reads the Email
 * Status column when the agent produced one and otherwise falls back to whether
 * the address parses at all. "verified" therefore means *the agent said it
 * verified this*, not that we checked — which is why the panel labels the source
 * of the claim rather than presenting it as our own finding.
 */
export function emailConfidence(email: string, status: string): EmailConfidence {
  if (!email) return "none";
  const s = status.toLowerCase();
  if (/\b(verified|valid|deliverable|confirmed|safe)\b/.test(s)) return "verified";
  if (/\b(invalid|undeliverable|bounce|unknown|not found|no match|risky|catch)\b/.test(s)) {
    return "none";
  }
  return "likely";
}

/** Map one flat Origami row onto our field names. Validation happens after. */
export function mapRow(row: Record<string, unknown>, map: ColumnMap): Record<string, string> {
  const { bySlug } = map;
  const email = cell(row, bySlug.email);
  return {
    name: cell(row, bySlug.name),
    company: cell(row, bySlug.company),
    title: cell(row, bySlug.title),
    email,
    phone: cell(row, bySlug.phone),
    linkedin: cell(row, bySlug.linkedin),
    location: cell(row, bySlug.location),
    sourceUrl: cell(row, bySlug.sourceUrl),
    emailConfidence: emailConfidence(email, cell(row, bySlug.emailStatus)),
  };
}

// ---------------------------------------------------------------------------
// Choosing which table to read
// ---------------------------------------------------------------------------

/**
 * Rows to sample from a candidate table before judging it.
 *
 * Ten is plenty to tell "every row has an email" from "almost none do", and the
 * difference we are looking for is a gulf, not a rounding error. Reading a whole
 * page to decide which page to read would be silly.
 */
export const TABLE_SAMPLE_ROWS = 10;

/**
 * How much better one table's email fill rate must be to win on merit rather
 * than on size, in percentage points.
 *
 * Twenty is deliberately coarse. We are separating "this is the filtered
 * deliverable" from "this is the raw search pool", which in practice differ by
 * most of the range — not tuning a threshold. Anything closer than this is noise
 * on a ten-row sample, so size decides instead.
 */
export const EMAIL_FILL_MARGIN = 0.2;

export type CandidateTable = { id?: string; name?: string; leadCount?: number };

export type TableCandidate = {
  table: CandidateTable;
  /** The table's columns, from listColumns. Empty when they couldn't be read. */
  columns: { slug?: string; name?: string; kind?: string }[];
  /**
   * A sample of the table's rows, already unwrapped from any `cells` envelope.
   * EMPTY MEANS UNKNOWN, not "no emails" — a table we failed to sample must not
   * be scored as though we had sampled it and found nothing.
   */
  sampledRows: Record<string, unknown>[];
};

export type TablePick = {
  table: CandidateTable | null;
  /** One line for the log, naming what actually decided it. */
  reason: string;
};

/**
 * Pick the table a finished run's results are actually in.
 *
 * WHY THIS IS NOT `sort BY leadCount DESC LIMIT 1`. That was the original rule
 * and it is wrong in exactly the case the feature is for. A brief with a hard
 * requirement in it — "must have a work email", "only companies still hiring" —
 * makes the agent build a raw search pool and then a filtered deliverable, and
 * the deliverable is SMALLER than the pool by construction. Biggest-wins picks
 * the pool every time, so the panel fills with the unfiltered candidates the
 * user explicitly asked to exclude, and it looks like the filter was ignored.
 *
 * Size is not meaningless — a scratch table really is usually small, which is
 * why the original heuristic worked at all — it just cannot be the only signal.
 *
 * So the tables are judged on what the CRM actually needs out of them: how many
 * of their rows carry an email address. A filtered deliverable is dense; a raw
 * pool is sparse. Where two tables are comparably dense, size breaks the tie and
 * the old behaviour is recovered.
 *
 * Pure and isomorphic like everything else in this module: the caller fetches
 * the samples, this only decides. The scoring is a plain fraction over a
 * ten-row sample, so it costs nothing and can be reasoned about in a test.
 */
export function pickResultTable(candidates: TableCandidate[]): TablePick {
  if (!candidates.length) return { table: null, reason: "the run built no tables" };
  if (candidates.length === 1) {
    return { table: candidates[0].table, reason: "the run built one table" };
  }

  const scored = candidates.map((c) => ({
    table: c.table,
    leads: Number(c.table.leadCount) || 0,
    fill: emailFillRate(c),
  }));

  const known = scored.filter((s) => s.fill !== null);

  // Nothing could be sampled, so there is no evidence to weigh and size is all
  // that is left. This is also the honest degradation when the rows endpoint is
  // having a bad day: it lands exactly on the old behaviour rather than on a
  // comparison built from half the data.
  if (!known.length) {
    const biggest = [...scored].sort((a, b) => b.leads - a.leads)[0];
    return {
      table: biggest.table,
      reason: `no rows could be sampled from ${scored.length} tables; fell back to the largest`,
    };
  }

  const maxFill = Math.max(...known.map((s) => s.fill as number));
  // Everything within a margin of the best fill rate is "comparably dense", and
  // among those the largest wins. Banding rather than comparing pairwise keeps
  // the choice transitive — a pairwise "is A meaningfully better than B" rule
  // gives different answers depending on the order the tables arrive in.
  const tier = known
    .filter((s) => (s.fill as number) >= maxFill - EMAIL_FILL_MARGIN)
    .sort((a, b) => b.leads - a.leads);

  const winner = tier[0];
  const beaten = known.find((s) => s.leads > winner.leads);

  return {
    table: winner.table,
    reason: beaten
      ? // The interesting case, and the one worth reading in a log: a bigger
        // table lost because its rows were mostly empty.
        `picked "${winner.table.name ?? winner.table.id}" (${pct(winner.fill)} of sampled rows have an email, ${winner.leads} leads) over the larger "${beaten.table.name ?? beaten.table.id}" (${pct(beaten.fill)}, ${beaten.leads} leads)`
      : `picked "${winner.table.name ?? winner.table.id}" (${pct(winner.fill)} of sampled rows have an email, ${winner.leads} leads)`,
  };
}

/**
 * What fraction of a candidate's sampled rows carry an email address, or null
 * when there is nothing to judge on.
 *
 * A table with no email column scores 0 rather than null: that is a real answer
 * about the table, not a gap in our evidence.
 */
function emailFillRate(candidate: TableCandidate): number | null {
  if (!candidate.sampledRows.length) return null;
  const slug = mapColumns(candidate.columns).bySlug.email;
  if (!slug) return 0;
  const filled = candidate.sampledRows.filter((row) => !!cell(row, slug)).length;
  return filled / candidate.sampledRows.length;
}

function pct(fill: number | null): string {
  return fill === null ? "unsampled" : `${Math.round(fill * 100)}%`;
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

export type DedupedProspect = ProspectFields & {
  dedupe: "email" | "name" | null;
  existingContactId: string | null;
};

/**
 * Flag prospects who are already in the CRM.
 *
 * Email first, because it is an identity: two people called Chris Nolan at
 * different companies are two people, but one address is one inbox, and pushing
 * a duplicate into a sequence is how a prospect gets two cold emails from the
 * same company. The name pass reuses buildNameIndex from data.ts — the same
 * index the contacts table already builds for its cross-owner conflict flag —
 * and is deliberately name-only rather than name-plus-company, because the
 * common case it catches is someone who changed jobs.
 *
 * Nothing is removed here. The caller stores the flag and the panel hides the
 * flagged rows, which is what keeps the count honest and re-openable.
 */
export function dedupeProspects(rows: ProspectFields[], contacts: Contact[]): DedupedProspect[] {
  const byEmail = new Map<string, Contact>();
  for (const c of contacts) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, c);
  }
  const byName: NameIndex = buildNameIndex(contacts);

  return rows.map((row) => {
    const email = (row.email ?? "").trim().toLowerCase();
    const emailHit = email ? byEmail.get(email) : undefined;
    if (emailHit) {
      return { ...row, dedupe: "email" as const, existingContactId: emailHit.id };
    }
    const nameHit = byName.get(normalizeName(row.name))?.[0];
    if (nameHit) {
      return { ...row, dedupe: "name" as const, existingContactId: nameHit.id };
    }
    return { ...row, dedupe: null, existingContactId: null };
  });
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

/** A prospect as it reaches the client. Mirrors one `prospects` row. */
export type Prospect = {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  sourceUrl: string | null;
  emailConfidence: EmailConfidence;
  dedupe: "email" | "name" | null;
  existingContactId: string | null;
  promotedContactId: string | null;
};

/**
 * Turn an approved prospect into the shape validateContact accepts.
 *
 * Status is always "New" — a prospect has by definition never been contacted,
 * and letting the panel choose would put a machine-found row straight into
 * "Replied". `source` carries the Loop 2 community/event when one was given; the
 * job title is not mapped anywhere, because `contacts` has no title column and
 * inventing one for this feature would be a schema change the CRM hasn't asked
 * for. It stays visible in the review list, which is where it earns its keep.
 */
export function toContactRow(
  prospect: Prospect,
  opts: { loop: number; owner: string | null; source: string | null },
): ContactFields {
  return {
    name: prospect.name,
    company: prospect.company ?? "",
    email: prospect.email,
    // Carried through rather than nulled: `contacts` has a phone column and the
    // detail panel already renders it, so a number the agent found is one fewer
    // thing to look up by hand. Length-capped in validateProspectRows, never
    // format-checked — a scraped number arrives in every shape there is.
    phone: prospect.phone,
    linkedin: prospect.linkedin,
    loops: [opts.loop],
    owner: opts.owner,
    status: "New",
    source: opts.source,
  };
}

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

/** Tallies recorded once at ingest, so the panel stays a plain mapper. */
export type RunCounts = {
  /** leadCount from response.tables[] — what the agent says it built. */
  found: number;
  /** Rows we actually read back, bounded by MAX_PROSPECTS_PER_RUN. */
  read: number;
  /** Rows dropped as unusable (no name). */
  skipped: number;
  /** Already in the CRM by email, and by name. */
  dedupedEmail: number;
  dedupedName: number;
  /** Of the new ones, how many carry an address at each confidence. */
  verified: number;
  likely: number;
  noEmail: number;
  /** Fields the agent's table had no column for. */
  missingColumns: string[];
};

/** One run of a thread, as it reaches the client. Mirrors a `prospect_runs` row. */
export type ProspectRun = {
  id: string;
  agentId: string | null;
  prompt: string;
  status: string;
  stage: string;
  summary: string | null;
  question: string | null;
  error: string | null;
  tableId: string | null;
  counts: RunCounts | null;
  nextActions: string[];
  /** Precomputed server-side against one `now`. No Date math in the render path. */
  agoLabel: string;
  elapsedSeconds: number;
};

export type ChecklistRow = {
  key: string;
  label: string;
  detail: string;
  state: "done" | "pending" | "warn";
};

export type RunView = {
  run: ProspectRun;
  /** The step list. Empty while running — Origami reports no mid-run progress. */
  checklist: ChecklistRow[];
  /** One sentence above the results table. */
  headline: string;
  /** Prospects worth reviewing: everything not already in the CRM. */
  visible: Prospect[];
  /** How many were hidden because they are already contacts. */
  hidden: number;
  /** True while Origami is still working on this run. */
  running: boolean;
  /** True when a follow-up run can continue from here. */
  resumable: boolean;
  /** True when the run ended badly and there is nothing to continue from. */
  failed: boolean;
};

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build everything the panel renders for one run.
 *
 * The checklist is assembled AFTER the run is terminal, from the counts we
 * recorded at ingest. That is not a shortcut: Origami reports `running` and
 * nothing else until it finishes, so a live five-step progress list would be an
 * animation of information we do not have. While running, the panel shows one
 * row and an elapsed timer instead.
 */
export function buildRunView(run: ProspectRun, prospects: Prospect[]): RunView {
  // Busy means OUR pipeline still owes work, not that Origami is still thinking.
  // A run can be `completed` upstream and still be mid-`reading` here, and
  // treating that as finished shows an empty result list for a run that found
  // people.
  const running = run.stage !== "ready" && run.stage !== "failed";
  const failed = run.status === "errored" || run.status === "timed_out" || run.stage === "failed";
  const resumable =
    run.status === "needs_input" ||
    run.status === "incomplete" ||
    run.status === "step_cap_hit" ||
    run.status === "cancelled";

  const visible = prospects.filter((p) => !p.dedupe);
  const hidden = prospects.length - visible.length;

  const c = run.counts;
  const checklist: ChecklistRow[] = [];

  if (c) {
    checklist.push({
      key: "searched",
      label: "Searched and scraped",
      detail: c.found
        ? `${plural(c.found, "candidate")} in the agent's table`
        : "The agent built no table",
      state: c.found ? "done" : "warn",
    });
    checklist.push({
      key: "read",
      label: "Read the results",
      detail: [
        plural(c.read, "row") + " read",
        c.skipped ? `${c.skipped} unusable` : "",
        c.missingColumns.length ? `no ${c.missingColumns.join(", ")} column` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      state: c.missingColumns.length || c.skipped ? "warn" : "done",
    });
    checklist.push({
      key: "enriched",
      label: "Checked emails",
      detail: `${c.verified} verified · ${c.likely} likely · ${c.noEmail} no match`,
      state: c.verified + c.likely > 0 ? "done" : "warn",
    });
    const deduped = c.dedupedEmail + c.dedupedName;
    checklist.push({
      key: "deduped",
      label: "Deduped against the CRM",
      detail: deduped
        ? `${plural(deduped, "person", "people")} already in Match Book, removed`
        : "Nothing was already in Match Book",
      state: "done",
    });
  }

  let headline: string;
  if (running) {
    headline =
      run.stage === "reading"
        ? "Reading the results the agent built."
        : "Researching. This usually takes one to five minutes.";
  } else if (failed) {
    headline = run.error || "The run didn't finish.";
  } else if (run.question) {
    headline = run.question;
  } else if (!visible.length) {
    headline = hidden
      ? `No new prospects: all ${hidden} were already in Match Book.`
      : "No prospects came back. Try describing them differently.";
  } else {
    const parts = [
      c?.verified ? `${c.verified} verified` : "",
      c?.likely ? `${c.likely} likely` : "",
      c?.noEmail ? `${c.noEmail} with no email` : "",
    ].filter(Boolean);
    // Phrased so the counts sit after the noun rather than in front of it —
    // "1 verified email addresses" is what happens when they don't.
    headline = `${plural(visible.length, "new prospect")}` +
      (parts.length ? ` (${parts.join(", ")}).` : ".");
  }

  return { run, checklist, headline, visible, hidden, running, resumable, failed };
}

/** Chip colours for an email-confidence label, in the shell's palette. */
export function confidenceChip(value: EmailConfidence): {
  label: string;
  bg: string;
  fg: string;
  title: string;
} {
  if (value === "verified") {
    return {
      label: "verified",
      bg: "#eef6ee",
      fg: "#4d6b4d",
      // The tooltip is where the derivation is admitted. See emailConfidence().
      title: "The agent reported this address as verified. Match Book did not check it.",
    };
  }
  if (value === "likely") {
    return {
      label: "likely",
      bg: "#fdf8ee",
      fg: "#8a6d3b",
      title: "A well-formed address the agent did not confirm.",
    };
  }
  return {
    label: "no match",
    bg: "#f4f4f1",
    fg: "#9a9a95",
    title: "No usable email address came back for this person.",
  };
}
