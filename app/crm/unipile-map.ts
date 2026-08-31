// Pure, isomorphic translation from Unipile's model to this CRM's — the same
// contract as ./smartlead-map.ts and ./analytics.ts. No React, no server
// imports, **no `Date`**. Everything /settings and the contacts strip render is
// precomputed by the loader; this module only decides what a message IS.
//
// THE HARD PART IS NOT FETCHING, IT IS DECIDING WHOSE REPLY IT IS. Unipile hands
// back messages, not contacts. Getting that wrong is not a cosmetic bug: a
// mismatched reply moves someone else's contact to `Replied`, writes a
// touchpoint onto their timeline, and puts a stranger's words on a card with
// their name on it. So every rule below errs toward NOT matching, and the sync
// reports what it skipped rather than guessing.
//
// The three rules, in the order they are tried:
//
//   1. **Email address** — exact, case-insensitive, against `contacts.email`.
//      The only rule with no ambiguity in it, and the one that handles the bulk
//      of replies, since the outbound half of this CRM is email.
//   2. **LinkedIn profile slug** — the `/in/<slug>` segment of the attendee's
//      profile URL against the same segment of `contacts.linkedin`. Also exact:
//      the slug is LinkedIn's own stable public identifier.
//   3. **Name** — case- and punctuation-insensitive, and ONLY when the name
//      resolves to exactly one contact. This is a real fallback rather than a
//      nicety, because a LinkedIn chat with an older connection can carry no
//      resolvable profile URL at all. It is also the rule most likely to be
//      wrong, so it carries two refusals: an ambiguous name matches nothing (see
//      hasNameConflict in ./data.ts — this book genuinely holds the same name
//      twice), and a contact whose stored LinkedIn URL DISAGREES with the
//      attendee's is never name-matched, since a mismatched slug is positive
//      evidence that this is a different person with the same name.
//
// Every match records which rule fired (`matchedOn`), stored on the reply row.
// It is the only record of why a reply landed where it did, and therefore the
// only way to diagnose a wrong one after the fact.

/** The two channels a reply can arrive on. Same keys as `CH` in ./data.ts. */
export type ReplyChannel = "email" | "linkedin";

/** Which rule matched a reply to a contact. Stored, for the reason above. */
export type ReplyMatchRule = "email" | "linkedin-profile" | "name";

/**
 * The contact fields this module needs. A structural subset of `Contact` rather
 * than the type itself, so the matcher can be reasoned about (and tested) without
 * constructing a whole contact.
 */
export type MatchableContact = {
  id: string;
  name: string;
  email?: string | null;
  linkedin?: string | null;
};

/** A message, normalised out of Unipile's two very different shapes. */
export type ReplyCandidate = {
  channel: ReplyChannel;
  accountId: string;
  providerMessageId: string;
  threadId: string | null;
  subject: string | null;
  snippet: string;
  senderName: string;
  /** The address or profile slug the match will be attempted on. */
  senderIdentifier: string;
  /** ISO, verbatim from the provider. */
  receivedAt: string;
};

export type MatchedReply = ReplyCandidate & {
  contactId: string;
  matchedOn: ReplyMatchRule;
};

export type ReplyPlan = {
  matched: MatchedReply[];
  /** Replies from someone who isn't a contact. Counted, not stored — see the sync. */
  unmatched: number;
  /**
   * The newest `receivedAt` seen across every candidate, matched or not — the
   * next watermark.
   *
   * It advances past UNMATCHED messages too, and that is the point: a mailbox
   * where nine of ten messages are newsletters would otherwise re-read those
   * nine on every sync forever. The cost is that adding a contact does not
   * retroactively surface the reply they already sent, which is the right trade
   * for a strip that exists to show what arrived since you last looked.
   */
  newest: string | null;
};

/**
 * A reply joined to its contact, exactly as the contacts page's "New replies"
 * strip renders it.
 *
 * Lives here rather than in crm.server.ts — which builds it — for the reason
 * `Contact` lives in ./data.ts: a client component must be able to name it
 * without importing a server module, and the loader/UI contract is a shape, not
 * a query. `daysAgo` is an integer computed against the loader's single `now`,
 * so nothing in the render path touches `Date`.
 */
export type ReplyCard = {
  id: string;
  contactId: string;
  contactName: string;
  company: string;
  /** 'email' | 'linkedin' — a key into CH, so the chip and the timeline agree. */
  channel: string;
  subject: string | null;
  snippet: string;
  senderName: string;
  /** The contact's owner, for the avatar. Null when unassigned. */
  owner: string | null;
  daysAgo: number;
};

/** How much of a message body is kept. See migrations/0021 for why it's a snippet. */
export const SNIPPET_CHARS = 280;

/**
 * Statuses a reply may move a contact out of.
 *
 * The exact mirror of SENT_PROMOTES_FROM in ./smartlead-map.ts, and for the same
 * reason: a reply arriving on a thread after someone booked a meeting, closed
 * the deal, or marked the contact dead must not walk that backwards. `New` is
 * included as well as `Contacted` because a reply can arrive on a conversation
 * this CRM never recorded sending — someone emailed from their own client, or
 * the contact wrote first.
 */
export const REPLY_PROMOTES_FROM: readonly string[] = ["New", "Contacted"];

/** The status a reply promotes a contact to. Must be a member of STATUSES. */
export const REPLY_STATUS = "Replied";

/**
 * Collapse a name to a comparison key: lowercase, punctuation dropped, runs of
 * whitespace flattened.
 *
 * Deliberately NOT unicode-normalising or stripping accents. "Naomi Sørensen"
 * and "Naomi Sorensen" are plausibly the same person, but they are equally
 * plausibly two, and this key is the last line before a reply is written onto a
 * contact by name alone. Folding them would make the riskiest rule the loosest.
 */
export function nameKey(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[.,'’"`()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercased, trimmed address. Empty string for anything unusable. */
export function emailKey(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().toLowerCase();
  // Guard against a display-name-only attendee ("Rafael Ortiz" with no address),
  // which would otherwise become a key that a contact with no email could match.
  return v.includes("@") ? v : "";
}

/**
 * The stable public identifier out of a LinkedIn profile URL — the `<slug>` in
 * `linkedin.com/in/<slug>`.
 *
 * Accepts every shape the CRM's `linkedin` column actually holds, because it is
 * free text typed by people and imported from CSVs: with or without a scheme,
 * with or without `www.`, on a country subdomain (`fr.linkedin.com`), with a
 * trailing slash, with tracking query parameters, and as a bare slug.
 *
 * Returns "" for a URL with no `/in/` segment — a company page, a post
 * permalink, or a Sales Navigator link. Those are real values in this column and
 * none of them identifies a person, so they must not become a match key that
 * two contacts could share.
 */
export function linkedinSlug(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "";

  // A bare slug, which is what a hand-typed cell often holds. Recognised before
  // any URL parsing so it isn't mistaken for a hostname.
  if (!v.includes("/") && !v.includes(".") && !v.includes("@")) {
    return v.toLowerCase();
  }

  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let path: string;
  try {
    path = new URL(withScheme).pathname;
  } catch {
    return "";
  }

  const match = /\/in\/([^/?#]+)/i.exec(path);
  if (!match) return "";
  // decodeURIComponent for the accented slugs LinkedIn percent-encodes; it
  // throws on a malformed escape, which is not a reason to fail a sync.
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return match[1].toLowerCase();
  }
}

/**
 * Flatten a message body to the snippet the card shows.
 *
 * Quoted history is cut at the first quote marker, not left in: a reply to a
 * three-round thread is mostly the previous three rounds, and a card showing our
 * own outbound copy back to us is worse than no preview. The markers cover the
 * three conventions in practice — a leading `>`, Gmail/Outlook's "On <date>, X
 * wrote:", and Outlook's `-----Original Message-----` rule.
 */
export function toSnippet(raw: string | null | undefined): string {
  let text = (raw ?? "").replace(/\r\n/g, "\n");

  const cutPoints = [
    text.search(/\n\s*>/),
    text.search(/\n\s*-{2,}\s*Original Message\s*-{2,}/i),
    text.search(/\n\s*On .{4,80}\bwrote:/),
    text.search(/\n\s*_{10,}/),
  ].filter((i) => i > 0);
  if (cutPoints.length) text = text.slice(0, Math.min(...cutPoints));

  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? flat.slice(0, SNIPPET_CHARS - 1).trimEnd() + "…" : flat;
}

/**
 * The three lookup tables the rules above consult, built once per sync.
 *
 * Ambiguity is resolved AT BUILD TIME, not at lookup time: a key held by two
 * contacts is dropped from its table entirely, so a lookup can only ever return
 * a contact that is the unique holder of that key. That is why the tables are
 * `Map<string, string | null>` internally — null marks "seen more than once" —
 * and why the exported lookup treats a missing key and a contested one the same
 * way. A rule that returns nothing is a reply the operator gets told about; a
 * rule that returns the wrong contact is one they never find out about.
 *
 * Email and slug are contested far more rarely than name, but they ARE
 * contested: two contacts at the same company sharing an info@ address, or a
 * duplicate row imported twice from different CSVs.
 */
export type ContactIndex = {
  byEmail: Map<string, string | null>;
  bySlug: Map<string, string | null>;
  byName: Map<string, string | null>;
  /** Slug per contact id, so the name rule can check for a disagreeing profile. */
  slugById: Map<string, string>;
};

function put(map: Map<string, string | null>, key: string, id: string): void {
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, id);
    return;
  }
  // Same contact twice (it appears in two source lists) is not a conflict.
  if (map.get(key) !== id) map.set(key, null);
}

export function buildContactIndex(contacts: MatchableContact[]): ContactIndex {
  const index: ContactIndex = {
    byEmail: new Map(),
    bySlug: new Map(),
    byName: new Map(),
    slugById: new Map(),
  };
  for (const c of contacts) {
    put(index.byEmail, emailKey(c.email), c.id);
    const slug = linkedinSlug(c.linkedin);
    put(index.bySlug, slug, c.id);
    if (slug) index.slugById.set(c.id, slug);
    put(index.byName, nameKey(c.name), c.id);
  }
  return index;
}

/** A unique holder of `key`, or null when unknown or contested. */
function unique(map: Map<string, string | null>, key: string): string | null {
  if (!key) return null;
  return map.get(key) ?? null;
}

/**
 * Resolve one email reply to a contact. Address only — an email carries a
 * display name too, but matching a stranger's inbox on "Dana Okafor" is exactly
 * the failure this module is built to avoid, and unlike LinkedIn there is no
 * case where the address is missing but the person is knowable.
 */
export function matchEmail(candidate: ReplyCandidate, index: ContactIndex): MatchedReply | null {
  const contactId = unique(index.byEmail, emailKey(candidate.senderIdentifier));
  return contactId ? { ...candidate, contactId, matchedOn: "email" } : null;
}

/**
 * Resolve one LinkedIn reply: profile slug first, then the guarded name rule.
 *
 * `profileUrl` is separate from the candidate's `senderIdentifier` because the
 * two are different facts — the identifier stored on the row is LinkedIn's
 * opaque provider id (which is what Unipile addresses the sender by and what a
 * future "open this chat" needs), while the slug is what a human-entered CRM
 * field can be compared against.
 */
export function matchLinkedin(
  candidate: ReplyCandidate,
  index: ContactIndex,
  attendee: { name?: string; profileUrl?: string },
): MatchedReply | null {
  const slug = linkedinSlug(attendee.profileUrl);
  const bySlug = unique(index.bySlug, slug);
  if (bySlug) return { ...candidate, contactId: bySlug, matchedOn: "linkedin-profile" };

  const byName = unique(index.byName, nameKey(attendee.name));
  if (!byName) return null;

  // The disagreement refusal. A contact whose stored profile points somewhere
  // else is positive evidence of a different person with the same name — the
  // slug rule above would already have matched them otherwise.
  const stored = index.slugById.get(byName);
  if (slug && stored && stored !== slug) return null;

  return { ...candidate, contactId: byName, matchedOn: "name" };
}

/**
 * Fold every candidate into a plan: matched replies, an unmatched count, and the
 * next watermark.
 *
 * Candidates are de-duplicated on (account, message id) — the same key as the
 * unique index behind the table — because one sync can legitimately see a
 * message twice: a LinkedIn chat that receives a new message mid-pagination
 * shifts the page boundary. The index would refuse the second write anyway; the
 * point of doing it here is that the count reported back is then the number of
 * replies, not the number of rows attempted.
 *
 * Timestamps are compared AS TEXT, not parsed. They all come from one provider
 * in one ISO UTC format, so lexical order is chronological order — the same
 * argument (and the same restraint about `Date`) as sendsByLead() in
 * ./smartlead-map.ts.
 */
export function planReplies(
  candidates: { candidate: ReplyCandidate; match: MatchedReply | null }[],
): ReplyPlan {
  const seen = new Set<string>();
  const matched: MatchedReply[] = [];
  let unmatched = 0;
  let newest: string | null = null;

  for (const { candidate, match } of candidates) {
    const key = `${candidate.accountId} ${candidate.providerMessageId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (candidate.receivedAt && (newest === null || candidate.receivedAt > newest)) {
      newest = candidate.receivedAt;
    }

    if (match) matched.push(match);
    else unmatched++;
  }

  // Oldest first, so a contact receiving two replies in one sync gets them
  // written to the timeline in the order they were sent.
  matched.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
  return { matched, unmatched, newest };
}

/**
 * The one sentence /settings shows after a sync, and stores as `last_result`.
 *
 * Built here rather than in the route so the wording is one thing, and so the
 * two callers (the contacts strip's Sync button and the settings page's) cannot
 * drift into describing the same operation differently.
 */
export function describeSync(counts: {
  accounts: number;
  replies: number;
  unmatched: number;
  promoted: number;
  failed: number;
}): string {
  const parts: string[] = [];
  parts.push(
    counts.replies === 1 ? "1 new reply" : `${counts.replies} new replies`,
  );
  if (counts.promoted > 0) {
    parts.push(`${counts.promoted} moved to ${REPLY_STATUS}`);
  }
  if (counts.unmatched > 0) {
    // Said out loud rather than swallowed: this number is the difference between
    // a quiet inbox and a matching rule that has stopped working.
    parts.push(
      counts.unmatched === 1
        ? "1 from someone not in the CRM"
        : `${counts.unmatched} from people not in the CRM`,
    );
  }
  if (counts.failed > 0) {
    parts.push(counts.failed === 1 ? "1 account failed" : `${counts.failed} accounts failed`);
  }
  const scope = counts.accounts === 1 ? "1 account" : `${counts.accounts} accounts`;
  return `${parts.join(", ")} across ${scope}.`;
}

/**
 * Split Unipile's account `type` into the channel this CRM reads it as.
 *
 * Returns null for the providers Unipile supports and this app does not
 * (WhatsApp, Telegram, Instagram, calendars). They are shown on /settings —
 * hiding a connected account would be lying about what the key can reach — but
 * they are never synced, and the page says so rather than leaving a row that
 * silently does nothing.
 */
export function channelForProvider(type: string | null | undefined): ReplyChannel | null {
  const t = (type ?? "").toUpperCase();
  if (t === "LINKEDIN") return "linkedin";
  if (t === "MAIL" || t === "GOOGLE_OAUTH" || t === "OUTLOOK" || t === "ICLOUD" || t === "EXCHANGE") {
    return "email";
  }
  return null;
}

/**
 * Whether Unipile considers an account healthy, from its per-source statuses.
 *
 * `OK` on every source is connected; anything else is not, and the raw status is
 * carried through to the page rather than collapsed to a boolean, because
 * `CREDENTIALS` (re-login needed) and `ERROR` ask the operator for different
 * things. An account with no sources at all is reported as unknown rather than
 * healthy — absence of a problem report is not a report of no problem.
 */
export function accountHealth(sources: { status?: string }[] | undefined): {
  ok: boolean;
  status: string;
} {
  const statuses = (sources ?? [])
    .map((s) => (s.status ?? "").toUpperCase())
    .filter(Boolean);
  if (!statuses.length) return { ok: false, status: "UNKNOWN" };
  const bad = statuses.find((s) => s !== "OK");
  return bad ? { ok: false, status: bad } : { ok: true, status: "OK" };
}
