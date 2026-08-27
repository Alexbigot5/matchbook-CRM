// Ported from the standalone "Sales Loop CRM" bundle. Data is generated with a
// seeded RNG and a fixed "today", so server and client render identically (no
// hydration mismatch).

export type Touch = {
  owner: string;
  ch: string;
  loop: number;
  daysAgo: number;
  note: string;
};

export type Note = { author: string; text: string; daysAgo: number };

export type ContactOpts = { mix?: boolean; unassigned?: boolean };

export type Contact = {
  id: string;
  name: string;
  company: string;
  // Contact-info channels (nullable - populated via the Add form / CSV import).
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  loops: number[];
  owner: string | null;
  status: string;
  touches: Touch[];
  notes: Note[];
  followUp: number | null;
  // Absolute due-date label ("Jul 20") for followUp, precomputed server-side so
  // no Date math runs during render. Null when there is no follow-up.
  followUpDateLabel?: string | null;
  // Loop 2 origin - the community/event a contact came from (e.g. "Newtopia").
  source?: string | null;
  // Brand facts backfilled from scripts/brand-directory.csv, matched on company
  // name. Null for the ~third of the book (influencer handles, test rows) the
  // directory has no entry for, so both render conditionally.
  category?: string | null;
  // Free text, not a number: the directory gives a figure for about 60% of
  // brands ("$5M - $20M") and an enrichment model's prose about why it could
  // not pin one down for the rest. See isArrFigure below.
  arr?: string | null;
  // When a Loop 2 contact was resumed into Loop 1 outbound: raw ISO timestamp
  // plus a precomputed "Jul 20"-style label (null when never resumed).
  resumedToLoop1At?: string | null;
  resumedLabel?: string | null;
  // Why a Dead contact died, captured when the status is set (see DEAD_REASONS in
  // app/lib/validate.ts). Null for contacts marked Dead before the column existed,
  // or when the person chose to skip the prompt.
  deadReason?: string | null;
  opts: ContactOpts;
};

/**
 * Longest `arr` value treated as a figure rather than a note. The two
 * populations in scripts/brand-directory.csv do not overlap and are not close:
 * every figure fits in 35 characters and every note runs to at least 109, so
 * this threshold sits in a 74-character gap where no real value lands.
 */
export const ARR_FIGURE_MAX = 60;

/**
 * True when `arr` holds the figure the column is named for ("$5M - $20M"),
 * false when it holds the enrichment model's prose about why it could not pin
 * one down ("Revenue is estimated based on secondary sources...").
 *
 * Length, not a currency pattern, because the notes are full of figures too
 * ("almost a million", "likely exceeds $5M annual revenue") — matching on "$"
 * or a digit would wave most of them straight through. Callers use this to keep
 * a paragraph out of a table cell; both kinds are still stored in full and both
 * are still shown somewhere.
 */
export function isArrFigure(arr: string | null | undefined): boolean {
  const v = (arr ?? "").trim();
  if (!v || v.length > ARR_FIGURE_MAX) return false;
  // Third shape, short enough to slip through on length alone: the screening
  // flags the directory carries for brands it never priced
  // ("under_100m=yes; over_5m=yes"). That is the answer to a qualifying
  // question, not a revenue figure, and rendering it beside a company name in
  // the contacts table reads as leaked internal plumbing. It is still shown in
  // full on the detail panel, where notes belong.
  return !/=\s*(yes|no)\b/i.test(v);
}

/**
 * The category groups a contact can be filtered by, in the order the dropdown
 * shows them.
 *
 * These exist because the brand directory spells roughly ten categories
 * thirty-six ways: "Food & Beverage", "Food & Bev", "Food/Bev", "Food/Beverage"
 * and "food/bev" are all in there, on brands that are the same kind of business.
 * A view built on the raw string would quietly match one spelling and miss the
 * other four, which is the worst possible failure for a filter — it looks like
 * it worked.
 *
 * The raw value stays on the contact untouched (it is what the directory said,
 * and the tag on the row shows it verbatim). This is a grouping applied at
 * filter time only, so re-grouping later is a code change and never a data
 * migration.
 */
export const CATEGORY_GROUPS = [
  "Food & Beverage",
  "Beauty & Personal Care",
  "Health & Wellness",
  "Household",
  "Pet",
  "Apparel & Accessories",
  "Toys & Games",
  "Alcohol",
  "Stationery & Office",
] as const;

export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

/**
 * Every raw category string the directory uses, mapped to its group. Keyed
 * lowercase because the same value appears cased both ways ("Food/Bev" and
 * "food/bev").
 *
 * Written out in full rather than inferred from substrings. "Beauty" contains
 * neither "personal" nor "care", "Snacks" contains neither "food" nor
 * "beverage", and a substring rule that stretched to cover those would also
 * fold "Household & Personal Care" into Beauty. An explicit table is longer and
 * says exactly what it does.
 *
 * Two judgement calls worth disagreeing with:
 *   - Alcohol is its own group, not a Food & Beverage. Different buyers,
 *     different rules about what you can say in an ad.
 *   - "Household & Personal Care" is filed under Household. It genuinely
 *     straddles two groups and there is one contact in it.
 */
const CATEGORY_GROUP_BY_RAW: ReadonlyMap<string, CategoryGroup> = new Map(
  (
    [
      ["Food & Beverage", "Food & Beverage"],
      ["Food & Bev", "Food & Beverage"],
      ["Food/Beverage", "Food & Beverage"],
      ["Food/Bev", "Food & Beverage"],
      ["Food", "Food & Beverage"],
      ["Food/Snacks", "Food & Beverage"],
      ["Snacks", "Food & Beverage"],
      ["Beverage", "Food & Beverage"],
      ["Beverages", "Food & Beverage"],
      ["Beauty", "Beauty & Personal Care"],
      ["Beauty & Personal Care", "Beauty & Personal Care"],
      ["Beauty Accessories", "Beauty & Personal Care"],
      ["Beauty/Skincare", "Beauty & Personal Care"],
      ["Personal Care", "Beauty & Personal Care"],
      ["Wellness", "Health & Wellness"],
      ["Wellness Products", "Health & Wellness"],
      ["Wellness/Supplements", "Health & Wellness"],
      ["Health", "Health & Wellness"],
      ["Health & Wellness", "Health & Wellness"],
      ["Supplements", "Health & Wellness"],
      ["Vitamins & Supplements", "Health & Wellness"],
      ["Fitness Supplements", "Health & Wellness"],
      ["Household", "Household"],
      ["Household Goods", "Household"],
      ["Household & Personal Care", "Household"],
      ["Pet", "Pet"],
      ["Pet Care", "Pet"],
      ["Pet Food", "Pet"],
      ["Apparel", "Apparel & Accessories"],
      ["Apparel & Accessories", "Apparel & Accessories"],
      ["Toys", "Toys & Games"],
      ["Toys & Games", "Toys & Games"],
      ["Toys & Hobbies", "Toys & Games"],
      ["Alcohol", "Alcohol"],
      ["Stationery & Office", "Stationery & Office"],
    ] as [string, CategoryGroup][]
  ).map(([raw, group]) => [raw.toLowerCase(), group]),
);

/**
 * The group a contact's raw category belongs to, or "" for no category and for
 * a spelling the table above has never seen.
 *
 * "" rather than an "Other" bucket on purpose: an Other option in the dropdown
 * would mix "this brand is in a vertical we have no group for" with "a new
 * spelling arrived and nobody has filed it yet", and the second is a thing to
 * fix in the table, not a category to prospect into. An unmapped value still
 * shows verbatim on the contact row; it just is not filterable until it is
 * mapped.
 */
export function categoryGroup(category: string | null | undefined): string {
  const v = (category ?? "").trim().toLowerCase();
  return v ? CATEGORY_GROUP_BY_RAW.get(v) ?? "" : "";
}

export type Channel = { label: string; bg: string; fg: string; icon: string };
export type StatusMeta = { id: string; dot: string; bg: string; fg: string };
export type Owner = { initial: string; color: string };

// The signed-in user's avatar badge. Resolved server-side in each route loader
// (see `viewerAvatar`) so the UI renders purely from loader data. Lives here
// rather than in a component file because both pages' shells need it.
export type Viewer = { name: string; initial: string; color: string };

export const CH: Record<string, Channel> = {
  ad: {
    label: "Dark ad",
    bg: "#f3f0ff",
    fg: "#6d3fc4",
    icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1Z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  },
  email: {
    label: "Email",
    bg: "#e9f1fb",
    fg: "#1e5aa8",
    icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  linkedin: {
    label: "LinkedIn",
    bg: "#e5f2f5",
    fg: "#0a7ea4",
    icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 8.5h-3V20h3V8.5ZM5 3.8A1.8 1.8 0 1 0 5 7.4 1.8 1.8 0 0 0 5 3.8ZM20.5 20h-3v-6c0-1.5-.6-2.3-1.8-2.3-1 0-1.6.7-1.8 1.4-.1.3-.1.6-.1 1V20h-3s.04-9.6 0-11.5h3v1.6c.4-.6 1.1-1.5 2.7-1.5 2 0 3.5 1.3 3.5 4.1V20Z"/></svg>',
  },
  call: {
    label: "Call",
    bg: "#e5f3ea",
    fg: "#1f7a4d",
    icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 4h3l1.5 4.5-2 1.5a11 11 0 0 0 5 5l1.5-2 4.5 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 4 6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  },
  meeting: {
    label: "Meeting",
    bg: "#eaecfb",
    fg: "#4457c9",
    icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m9 14 2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
};

export const NO_TOUCH_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3"/></svg>';

export const STATUSES: StatusMeta[] = [
  { id: "New", dot: "#a1a1aa", bg: "#f2f2f0", fg: "#57575a" },
  { id: "Contacted", dot: "#3b82f6", bg: "#e9f1fb", fg: "#1e5aa8" },
  { id: "Replied", dot: "#8b5cf6", bg: "#f1ecfb", fg: "#6b3fb5" },
  { id: "Meeting booked", dot: "#10b981", bg: "#e4f3ea", fg: "#1f7a4d" },
  { id: "Won", dot: "#059669", bg: "#d5efdf", fg: "#146c3a" },
  { id: "Dead", dot: "#ef4444", bg: "#f4ecec", fg: "#9a5b5b" },
];

// Avatar colours/initials, keyed by display name. Tom and Britton are the only
// owners contacts get *assigned* to, but Alex and Mike can sign in and author
// notes, so they need entries here too — the note-author lookups in
// sales-loop-crm.tsx index straight into this map.
export const OWNERS: Record<string, Owner> = {
  Tom: { initial: "T", color: "#4457c9" },
  Britton: { initial: "B", color: "#0d8f7a" },
  Alex: { initial: "A", color: "#b45309" },
  Mike: { initial: "M", color: "#7c3aed" },
};
const FALLBACK_AVATAR: Owner = { initial: "?", color: "#b0b0aa" };

// Avatar for an arbitrary name from the DB or the session. `Object.hasOwn` rather
// than a bare `OWNERS[name]`, which walks the prototype chain — "constructor"
// returns a function, not undefined, so `?? fallback` never fires for it.
export function ownerAvatar(name: string | null | undefined): Owner {
  if (!name) return FALLBACK_AVATAR;
  if (Object.hasOwn(OWNERS, name)) return OWNERS[name];
  return { initial: (name.slice(0, 1) || "?").toUpperCase(), color: FALLBACK_AVATAR.color };
}

export const TODAY = new Date(2026, 6, 16);

export function dateFrom(daysAgo: number) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - daysAgo);
  return d;
}
export function fmtDate(daysAgo: number) {
  return dateFrom(daysAgo).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
export function ago(daysAgo: number) {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "1d ago";
  if (daysAgo < 7) return daysAgo + "d ago";
  if (daysAgo < 14) return "1w ago";
  return Math.floor(daysAgo / 7) + "w ago";
}

export function peopleInvolved(c: Contact) {
  const s = new Set<string>();
  if (c.owner) s.add(c.owner);
  c.touches.forEach((t) => s.add(t.owner));
  return s;
}
export function hasConflict(c: Contact) {
  return peopleInvolved(c).size > 1;
}

// --- Duplicate / cross-owner conflict detection ---------------------------
// Touchpoints have no write path, so touch-owner conflict (`hasConflict`) never
// fires. Instead we flag when the SAME contact name is held by two different
// owners - e.g. both Tom and Britton have a "Jane Smith". Detection needs the
// whole contact list, so it's built once into a name index.

export type NameIndex = Map<string, Contact[]>;

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Generic over the row shape so callers that only hold a name (the CSV-import
// dedupe reads just id/name/email out of the contacts table) can share this one
// implementation instead of fabricating whole Contacts to satisfy the type.
// Passing Contact[] still yields a NameIndex, which is what every UI caller does.
export function buildNameIndex<T extends { name: string }>(contacts: T[]): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const c of contacts) {
    const key = normalizeName(c.name);
    if (!key) continue;
    const list: T[] = idx.get(key) ?? [];
    list.push(c);
    idx.set(key, list);
  }
  return idx;
}

// Distinct non-null owners across every contact sharing c's name.
function ownersForName(c: Contact, index: NameIndex): string[] {
  const peers = index.get(normalizeName(c.name)) ?? [];
  const owners = new Set<string>();
  for (const p of peers) if (p.owner) owners.add(p.owner);
  return [...owners];
}

// True when c's name is held by 2+ distinct owners (a cross-owner duplicate).
export function hasNameConflict(c: Contact, index: NameIndex): boolean {
  return ownersForName(c, index).length >= 2;
}

// The OTHER owners (relative to c) in a cross-owner duplicate; [] if no conflict.
export function conflictOwners(c: Contact, index: NameIndex): string[] {
  const all = ownersForName(c, index);
  if (all.length < 2) return [];
  return all.filter((o) => o !== c.owner);
}
export function statusMeta(id: string) {
  return STATUSES.find((s) => s.id === id) || STATUSES[0];
}

export function needsAttention(c: Contact): { flag: boolean; reason?: string } {
  if (!c.owner) return { flag: true, reason: "Unassigned" };
  if (c.touches.length === 0) return { flag: true, reason: "Not contacted yet" };
  if (c.followUp !== null && c.followUp <= 0) {
    const due = -c.followUp;
    return {
      flag: true,
      reason: due === 0 ? "Follow-up due today" : "Follow-up in " + due + "d",
    };
  }
  const last = c.touches.length ? c.touches[0].daysAgo : 99;
  if ((c.status === "Contacted" || c.status === "New") && last >= 7)
    return { flag: true, reason: "No reply · " + ago(last) };
  return { flag: false };
}

export function loopBadge(loop: number, small: boolean) {
  if (loop === 2)
    return {
      label: "Loop 2",
      title: "Loop 2 · event/community blitz",
      style: `display:inline-flex;align-items:center;padding:${small ? "2px 7px" : "3px 9px"};border-radius:6px;font-size:11px;font-weight:500;background:#fdf0d9;color:#b45309;white-space:nowrap;`,
    };
  return {
    label: "Loop 1",
    title: "Loop 1 · always-on outbound",
    style: `display:inline-flex;align-items:center;padding:${small ? "2px 7px" : "3px 9px"};border-radius:6px;font-size:11px;font-weight:500;background:#f0f0ec;color:#575753;white-space:nowrap;`,
  };
}
export function statusPill(status: string, forDetail: boolean) {
  const m = statusMeta(status);
  const pad = forDetail ? "5px 11px" : "3px 9px";
  return `display:inline-flex;align-items:center;gap:6px;padding:${pad};border-radius:7px;font-size:12px;font-weight:500;background:${m.bg};color:${m.fg};border:none;cursor:pointer;font-family:inherit;white-space:nowrap;`;
}
