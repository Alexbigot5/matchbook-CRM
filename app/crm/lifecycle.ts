// The lifecycle stage model, backing the /lifecycle kanban board.
//
// Pure and isomorphic, the same contract as ./analytics.ts and ./ab.ts: no React,
// no server imports, and **no `Date`**. Colours and labels are precomputed here so
// lifecycle-page.tsx stays a plain mapper.
//
// A lifecycle stage is DERIVED from a contact's `status` - there is no `lifecycle`
// column in D1 and deliberately so. `contacts.status` stays the single source of
// truth for where someone sits in the pipeline; this module is a presentation of
// it that groups the six statuses into the five stages the board shows. Moving a
// card writes a real status through the existing `setStatus` intent.

import { STATUSES, type Contact } from "./data";

export type LifecycleStage = {
  id: string;
  /** One-line description under the column title. */
  caption: string;
  /** 8px dot beside the column title. */
  dot: string;
  /** Column background wash. */
  tint: string;
  border: string;
  /** Column title colour - the dot hue darkened enough to read as text. */
  fg: string;
  /** Which `STATUSES` ids land in this column. */
  statuses: string[];
  /**
   * The status written when a card is dropped here. For every stage but
   * Opportunity this is the stage's only status; see STAGE_OF below for why the
   * many-to-one case never actually reaches a write.
   */
  canonical: string;
};

/**
 * The five columns, in pipeline order.
 *
 * The palette is the board's own visual language rather than a reuse of the
 * `STATUSES` colours - Opportunity is amber here but "Replied" is violet in the
 * status pill. That's deliberate and safe: kanban cards carry no status pill, so
 * the two vocabularies never appear side by side.
 */
export const LIFECYCLE_STAGES: LifecycleStage[] = [
  {
    id: "Lead",
    caption: "Not qualified yet",
    dot: "#a1a1aa",
    tint: "#fbfbfa",
    border: "#ededea",
    fg: "#57575a",
    statuses: ["New"],
    canonical: "New",
  },
  {
    id: "Prospect",
    caption: "Engaged, qualifying",
    dot: "#3b82f6",
    tint: "#f7fafd",
    border: "#e3ecf7",
    fg: "#1e5aa8",
    statuses: ["Contacted"],
    canonical: "Contacted",
  },
  {
    id: "Opportunity",
    caption: "Active deal",
    dot: "#e0930a",
    tint: "#fdfaf4",
    border: "#f2e6cf",
    fg: "#b45309",
    statuses: ["Replied", "Meeting booked"],
    canonical: "Replied",
  },
  {
    id: "Customer",
    caption: "Closed and onboarded",
    dot: "#10b981",
    tint: "#f6fbf8",
    border: "#dcefe4",
    fg: "#1f7a4d",
    statuses: ["Won"],
    canonical: "Won",
  },
  {
    id: "Churned",
    caption: "Lapsed or lost",
    dot: "#ef4444",
    tint: "#fdf8f8",
    border: "#f2e2e2",
    fg: "#9a5b5b",
    statuses: ["Dead"],
    canonical: "Dead",
  },
];

const FALLBACK_STAGE = LIFECYCLE_STAGES[0];

/**
 * status id -> stage. Built once at module load.
 *
 * `STATUSES` in data.ts is the source of truth for what a status can be, and this
 * file lists them a second time. Adding a status there without adding it here
 * would otherwise make those contacts silently vanish from the board - present in
 * the header count, in no column. Every unmapped status is therefore folded into
 * the first stage, so the board is always a complete partition of the contact
 * list. That mirrors how validate.ts derives STATUS_IDS from data.ts rather than
 * restating it.
 */
const STAGE_OF: Map<string, LifecycleStage> = (() => {
  const index = new Map<string, LifecycleStage>();
  for (const stage of LIFECYCLE_STAGES) {
    for (const status of stage.statuses) {
      // A status claimed by two stages would put the same contact in two columns
      // and break the "columns partition the list" invariant the header count
      // relies on. Both operands are module constants, so this either throws on
      // the first render in dev or can never throw at all - a static assertion
      // that happens to run at import time.
      if (index.has(status)) {
        throw new Error(`lifecycle: status "${status}" is claimed by two stages`);
      }
      index.set(status, stage);
    }
  }
  for (const s of STATUSES) {
    if (!index.has(s.id)) index.set(s.id, FALLBACK_STAGE);
  }
  return index;
})();

/** The stage a contact's status belongs to. Never null - see STAGE_OF. */
export function stageOf(status: string): LifecycleStage {
  return STAGE_OF.get(status) ?? FALLBACK_STAGE;
}

/**
 * True when `status` already sits in `stageId`.
 *
 * This is what makes Opportunity's two statuses safe. Dropping a card on the
 * column it is already in is a no-op, so dragging a "Meeting booked" contact
 * around inside Opportunity never quietly rewrites it to the column's canonical
 * "Replied" and demotes the deal.
 */
export function isInStage(status: string, stageId: string): boolean {
  return stageOf(status).id === stageId;
}

export type LifecycleColumn = {
  stage: LifecycleStage;
  contacts: Contact[];
  count: number;
};

export type LifecycleBoard = {
  columns: LifecycleColumn[];
  /** Contacts placed across all columns - i.e. the filtered list's length. */
  total: number;
};

/**
 * Group contacts into the five columns. Order within a column follows the input
 * order, which is `listContacts`' newest-created-first.
 */
export function computeLifecycleBoard(contacts: Contact[]): LifecycleBoard {
  const byStage = new Map<string, Contact[]>();
  for (const stage of LIFECYCLE_STAGES) byStage.set(stage.id, []);

  for (const c of contacts) {
    byStage.get(stageOf(c.status).id)!.push(c);
  }

  const columns = LIFECYCLE_STAGES.map((stage) => {
    const list = byStage.get(stage.id)!;
    return { stage, contacts: list, count: list.length };
  });

  return { columns, total: contacts.length };
}
