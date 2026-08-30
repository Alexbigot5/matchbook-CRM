// Saved views: the filter-condition model behind the contacts page's "New view"
// builder and the saved rows in the sidebar's VIEWS group.
//
// Deliberately its own module rather than an addition to ./data.ts — that file is
// the *contacts* model, exactly as ./templates.ts is the templates one. This is
// the contract between listSavedViews() in app/lib/crm.server.ts and the contacts
// UI, and app/lib/validate.ts imports the closed sets below to whitelist them
// (the same direction TEMPLATE_STATUSES runs in).
//
// Pure and isomorphic: no React, no server imports, and no `Date`. That is what
// lets the builder compute its live "Matches — N contacts" figure client-side
// with no round trip, and keeps SSR and hydration byte-identical.
//
// SECURITY: `conditions` is a stored filter DSL that is evaluated in JS against
// contacts the loader already fetched. It is NEVER compiled into SQL. If someone
// later "optimises" this into a WHERE clause assembled from the stored field/op
// strings, the whitelists in validate.ts become the only thing standing between a
// saved view and injection — so don't, or move the whitelist to the query.
//
// SEMANTICS worth knowing before touching matchesConditions:
//
//   * Conditions combine with AND. There is no OR, though "+ Add condition"
//     rather implies one.
//   * `loop is 1` is `loops.includes(1)`, and `loops` is NOT exclusive — a Loop 2
//     contact resumed into Loop 1 keeps both, and satisfies both conditions. Same
//     fact planLeads() in ./smartlead-map.ts guards against.
//   * `owner is not Tom` MATCHES unassigned contacts. `!(c.owner === "Tom")` is
//     the defensible reading of "is not", and stating it here is cheaper than
//     having it rediscovered as a bug report.
//   * `category is Food & Beverage` matches on the GROUP, not the stored string.
//     The directory spells ten categories thirty-six ways, so the raw value is
//     mapped through categoryGroup() in ./data.ts first.
//   * A category can be COMPOUND ("Food & Beverage;Grocery Retail"), so
//     categoryGroup returns every group its segments map to and the clause holds
//     if `value` is ANY of them. That contact satisfies `category is Food &
//     Beverage` and `category is Grocery Retail` both — the same
//     non-exclusivity `loop` has above, for the same reason: the stored value
//     was always a set, not a single label.
//   * Recognition is per segment, so it degrades partially rather than totally.
//     A contact with one spelling the table knows and one it does not still
//     matches on the half it knows. Only a contact where NO segment is mapped —
//     or that has no category at all — is in no group and matches no category
//     condition, deliberately; see the note on categoryGroup.
//   * `category is not Food & Beverage` therefore MATCHES a contact with no
//     category at all, which is most of the book. Same reading as `owner is
//     not Tom` above, and the same trap: pair it with another condition. Note
//     it now also EXCLUDES a contact that is only partly Food & Beverage: one
//     recognized segment is enough to fail an isNot on that group.
//   * matchesConditions(c, []) is true (a vacuous AND). validateSavedView refuses
//     to save an empty condition list, so that only happens for a corrupt or
//     hand-edited row — and showing everything is the safer failure than showing
//     nothing, which reads as data loss.

import { CATEGORY_GROUPS, categoryGroup, STATUSES, type Contact } from "./data";

export type ViewOp = "is" | "isNot";

/** One clause of a saved view. `field`/`op` are whitelisted in app/lib/validate.ts. */
export type ViewCondition = { field: string; op: ViewOp; value: string };

export type SavedView = {
  id: string;
  name: string;
  /** true = every user sees it; false = only its creator. */
  shared: boolean;
  createdByName: string;
  /**
   * Whether the viewer created it, resolved in the loader.
   *
   * Note what this type does NOT carry: the creator's email. The UI `Viewer`
   * (./data.ts) deliberately has no email either, and listSavedViews already
   * knows the viewer's address — so the comparison happens server-side and three
   * colleagues' addresses stay out of the page payload. Same "expose the derived
   * value, not the raw input" rule that has EmailTemplate expose `runningDays`
   * rather than `started_at`.
   */
  mine: boolean;
  conditions: ViewCondition[];
};

export const VIEW_FIELD_KEYS = ["status", "owner", "loop", "category"] as const;
export const VIEW_OPS = ["is", "isNot"] as const;

/**
 * Display labels for the operator dropdown. The stored value is "isNot", not
 * "is not": the op round-trips FormData -> JSON -> D1 -> JSON, and a
 * whitespace-bearing enum on that path is gratuitous risk for no gain.
 */
export const VIEW_OP_LABELS: Record<ViewOp, string> = { is: "is", isNot: "is not" };

/** The sentinel `owner` value for "nobody owns this contact". */
export const UNASSIGNED = "unassigned";

export type ViewFieldOption = { value: string; label: string };
export type ViewField = { key: string; label: string; options: ViewFieldOption[] };

/**
 * The three filterable fields and the closed set of values each accepts.
 * validateSavedView checks a condition's value against exactly these lists.
 *
 * Owner options are hardcoded Tom / Britton / Unassigned, mirroring
 * buildOwnerTabs() in ./sidebar.tsx — NOT built from OWNERS in ./data.ts. OWNERS
 * has four entries because Alex and Mike can sign in and author notes, but
 * contacts are only ever *assigned* to Tom and Britton, so deriving the dropdown
 * from it would offer two options that match zero contacts forever.
 *
 * "unassigned" is a sentinel string rather than "": an empty value is rejected by
 * the validator, which would leave "owner is unassigned" inexpressible.
 */
export const VIEW_FIELDS: ViewField[] = [
  {
    key: "status",
    label: "Status",
    options: STATUSES.map((s) => ({ value: s.id, label: s.id })),
  },
  {
    key: "owner",
    label: "Owner",
    options: [
      { value: "Tom", label: "Tom" },
      { value: "Britton", label: "Britton" },
      { value: UNASSIGNED, label: "Unassigned" },
    ],
  },
  {
    key: "loop",
    label: "Loop",
    options: [
      { value: "1", label: "Loop 1 · always-on" },
      { value: "2", label: "Loop 2 · community blitz" },
    ],
  },
  {
    // Values are the GROUP labels, not the raw category strings. A closed set
    // like the other three, which is what keeps validateSavedView's per-field
    // whitelist working unchanged — and what stops a saved view from carrying a
    // spelling that matches nothing.
    key: "category",
    label: "Category",
    options: CATEGORY_GROUPS.map((g) => ({ value: g, label: g })),
  },
];

const FIELD_BY_KEY = new Map(VIEW_FIELDS.map((f) => [f.key, f]));

/** The value options for a field key, or [] if the key isn't one of the three. */
export function optionsForField(field: string): ViewFieldOption[] {
  return FIELD_BY_KEY.get(field)?.options ?? [];
}

/** Human label for a field key, falling back to the raw key. */
export function labelForField(field: string): string {
  return FIELD_BY_KEY.get(field)?.label ?? field;
}

/**
 * The condition a new row starts as, shared by the builder's initial state and
 * its "+ Add condition" button so the two can't drift.
 */
export function defaultCondition(): ViewCondition {
  return { field: "status", op: "is", value: STATUSES[0].id };
}

/** The first valid value for a field — used when switching a row's field. */
export function defaultValueForField(field: string): string {
  return optionsForField(field)[0]?.value ?? "";
}

// --- Sidebar keys ----------------------------------------------------------
// The contacts page holds ONE view selection (`State.view`), whose built-in keys
// are "all" / "loop1" / "loop2". A saved view is a fourth form of that same slot,
// which is what lets the owner, source, stage and search filters keep layering on
// top with no change. The prefix lives here, in one module, rather than as a
// string literal repeated across six expressions in the page.

export const VIEW_KEY_PREFIX = "view:";

export function savedViewKey(id: string): string {
  return VIEW_KEY_PREFIX + id;
}

/** The saved-view id inside a sidebar key, or null for a built-in key. */
export function savedViewIdFromKey(key: string): string | null {
  return key.startsWith(VIEW_KEY_PREFIX) ? key.slice(VIEW_KEY_PREFIX.length) : null;
}

/**
 * The saved view a sidebar key selects, or null.
 *
 * Callers resolve this during render rather than reconciling `State.view` in an
 * effect: a view deleted here or by another user in another tab then degrades to
 * "All contacts" with no frame ever rendered against a dead id. Same choice
 * ./ab.ts makes for the templates page's selected card.
 */
export function resolveSavedView(views: SavedView[], key: string): SavedView | null {
  const id = savedViewIdFromKey(key);
  if (id === null) return null;
  return views.find((v) => v.id === id) ?? null;
}

// --- Matching --------------------------------------------------------------

function satisfies(c: Contact, field: string, value: string): boolean {
  switch (field) {
    case "status":
      return c.status === value;
    case "owner":
      return value === UNASSIGNED ? !c.owner : c.owner === value;
    case "loop":
      return c.loops.includes(Number(value));
    case "category":
      // Groups, not raw string — see the header. `includes`, not equality: a
      // compound category resolves to one group per recognized segment and the
      // clause holds on any of them. A contact with no category, or none whose
      // spelling is mapped, resolves to [] and matches nothing.
      return categoryGroup(c.category).includes(value);
    default:
      // An unknown field can only come from a corrupt row (parseConditions drops
      // them). Match nothing rather than everything, so a broken clause narrows
      // the list visibly instead of silently disappearing.
      return false;
  }
}

export function matchesCondition(c: Contact, cond: ViewCondition): boolean {
  const hit = satisfies(c, cond.field, cond.value);
  return cond.op === "isNot" ? !hit : hit;
}

/** AND across every condition. An empty list matches everything — see the header. */
export function matchesConditions(c: Contact, conditions: ViewCondition[]): boolean {
  return conditions.every((cond) => matchesCondition(c, cond));
}

// --- Storage ---------------------------------------------------------------

const OP_SET: ReadonlySet<string> = new Set(VIEW_OPS);

/**
 * Read the stored `conditions` JSON text back into clauses, tolerantly.
 *
 * A hand-edited or partially-written row must not throw inside a loader, so this
 * parses in a try and drops any entry whose field, op or value isn't one this
 * module recognises — the same discipline as parseLoops()/parseTemplateStatus()
 * in app/lib/crm.server.ts.
 */
export function parseConditions(raw: string): ViewCondition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ViewCondition[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { field, op, value } = entry as Record<string, unknown>;
    if (typeof field !== "string" || typeof value !== "string") continue;
    if (typeof op !== "string" || !OP_SET.has(op)) continue;
    if (!FIELD_BY_KEY.has(field)) continue;
    out.push({ field, op: op as ViewOp, value });
  }
  return out;
}
