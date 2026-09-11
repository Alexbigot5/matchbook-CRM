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
//     or that has no category at all — is in no group, deliberately; see the
//     note on categoryGroup.
//   * `category is Other` is the leftover bucket: a contact with ANY segment no
//     group covers (hasOtherCategory in ./data.ts). Per segment like the groups,
//     so a half-mapped compound value is in its group AND in Other. A blank
//     category is in neither. A new spelling of a known vertical also lands in
//     Other until the grouping table learns it.
//   * `category is not Food & Beverage` therefore MATCHES a contact with no
//     category at all, which is most of the book. Same reading as `owner is
//     not Tom` above, and the same trap: pair it with another condition. Note
//     it now also EXCLUDES a contact that is only partly Food & Beverage: one
//     recognized segment is enough to fail an isNot on that group.
//   * `todo is call` asks what ./todo.ts says the SINGLE next action on a
//     contact is — not whether a call is one of several things you could do.
//     That is what makes the field a partition rather than a tag: every contact
//     is in at most one to-do group, so "Calls to make" and "LinkedIn
//     follow-ups" saved side by side never double-count anybody. It also means
//     the set moves on its own: logging the call takes the contact out of the
//     view, which is the behaviour you want from a work queue and NOT the
//     behaviour the other four fields have.
//   * `todo is not call` therefore MATCHES every contact with no to-do at all —
//     the whole Won/Dead/recently-contacted population. Same reading as `owner
//     is not Tom` above, and the same advice: pair it with another condition.
//   * `tags is none` asks whether the contact carries ANY industry tag, not
//     which one. Deliberately not a per-tag-name field: tag names are rows in
//     D1, and VIEW_FIELDS is the static closed set validate.ts whitelists
//     against — a dropdown built from the tags table would either have to be
//     threaded through the validator or drop the whitelist entirely. Filtering
//     BY a specific tag is already the sidebar's TAGS group; what that group
//     cannot express, because it only lists names that exist, is the absence of
//     all of them. Hence one two-valued field rather than N.
//   * `tags` is the only field whose two values are each other's negation, so
//     `is none` and `is not any` select the same contacts. Kept symmetric with
//     the other four rather than special-cased into a single value: the op
//     dropdown is rendered for every row, and a field where one of its two
//     options is a no-op would be stranger than a redundant pair.
//   * Empty tags mean "created before migration 0020 shipped", not "reviewed
//     and found to have no industry" — nothing backfills them (see the note on
//     Tag in ./data.ts). So `tags is none` is most of the book today, and is
//     worth pairing with a condition that narrows it to the contacts you would
//     actually go and tag.
//   * matchesConditions(c, []) is true (a vacuous AND). validateSavedView refuses
//     to save an empty condition list, so that only happens for a corrupt or
//     hand-edited row — and showing everything is the safer failure than showing
//     nothing, which reads as data loss.

import {
  CATEGORY_GROUPS,
  categoryGroup,
  hasOtherCategory,
  OTHER_CATEGORY,
  STATUSES,
  type Contact,
} from "./data";
import { nextTodo, TODO_KINDS, TODO_META } from "./todo";

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

export const VIEW_FIELD_KEYS = ["status", "owner", "loop", "category", "tags", "todo"] as const;
export const VIEW_OPS = ["is", "isNot"] as const;

/**
 * Display labels for the operator dropdown. The stored value is "isNot", not
 * "is not": the op round-trips FormData -> JSON -> D1 -> JSON, and a
 * whitespace-bearing enum on that path is gratuitous risk for no gain.
 */
export const VIEW_OP_LABELS: Record<ViewOp, string> = { is: "is", isNot: "is not" };

/** The sentinel `owner` value for "nobody owns this contact". */
export const UNASSIGNED = "unassigned";

/**
 * The two `tags` values: carries no industry tag, and carries at least one.
 *
 * Sentinels rather than a tag name for the same reason UNASSIGNED is one — the
 * field asks about presence, and presence is not spellable as a member of the
 * set it is asking about.
 */
export const TAGS_NONE = "none";
export const TAGS_ANY = "any";

export type ViewFieldOption = { value: string; label: string };
export type ViewField = { key: string; label: string; options: ViewFieldOption[] };

/**
 * The six filterable fields and the closed set of values each accepts.
 * validateSavedView checks a condition's value against exactly these lists.
 *
 * Owner options are hardcoded Tom / Britton / Mike / Unassigned — NOT built from
 * OWNERS in ./data.ts. OWNERS has an entry for everyone who can sign in and
 * author notes, which includes Alex, and contacts are not assigned to him, so
 * deriving the dropdown from it would offer an option that matches zero contacts
 * forever. Mike is listed because contacts do get assigned to him: the CSV
 * import reads an Owner column of "Mike" (parseImportOwner in ./import-map.ts)
 * and isValidOwner accepts it. The sidebar's buildOwnerTabs() in ./sidebar.tsx
 * still lists only Tom and Britton.
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
      { value: "Mike", label: "Mike" },
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
    // Other last, after every named group, since it means "none of the above".
    options: [...CATEGORY_GROUPS, OTHER_CATEGORY].map((g) => ({ value: g, label: g })),
  },
  {
    // Presence, not identity: "does this contact have industry tags at all",
    // never "which". See the header for why this is two fixed values and not a
    // dropdown of the tags table, and ./sidebar.tsx's TAGS group for the
    // filter-by-name half that this one is the complement of.
    key: "tags",
    label: "Tags",
    options: [
      { value: TAGS_NONE, label: "None" },
      { value: TAGS_ANY, label: "Any" },
    ],
  },
  {
    // The one DERIVED field: nothing on the contact stores a to-do, ./todo.ts
    // computes it from status, touch channels and the follow-up date. That is
    // what makes "Calls to make" expressible as a saved view at all — the four
    // fields above can describe who a contact IS, and none of them can describe
    // what is owed on them.
    //
    // Values are the TodoKind strings, so a saved view survives a wording
    // change to the group headings on the page. Kept in TODO_KINDS order,
    // which is the page's own priority order.
    key: "todo",
    label: "To do",
    options: TODO_KINDS.map((k) => ({ value: k, label: TODO_META[k].viewLabel })),
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
      // spelling is mapped, resolves to [] and matches no group — Other is the
      // one value that asks about the unmapped segments instead.
      if (value === OTHER_CATEGORY) return hasOtherCategory(c.category);
      return categoryGroup(c.category).includes(value);
    case "tags":
      // `?.length`, not a null check: `tags` is optional on Contact, but
      // listContacts always sets it (to [] when the join found nothing), so
      // undefined only reaches here from a Contact built somewhere else — and
      // "no tags array" and "an empty tags array" are the same answer to this
      // question either way.
      return value === TAGS_NONE ? !c.tags?.length : !!c.tags?.length;
    case "todo":
      // The contact's ONE next action, not a set membership — see the header.
      // `?.kind` rather than a null check: a contact with nothing to do matches
      // no todo condition, which is the same "in no group" behaviour an
      // uncategorised contact has above.
      return nextTodo(c)?.kind === value;
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
