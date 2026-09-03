// Campaign aggregation for the /analytics page's "Email campaigns" tab.
//
// Pure and isomorphic, the same contract as ./analytics.ts and ./ab.ts: no React,
// no server imports, and — critically — no `Date`. Every absolute label arrives
// precomputed from the loader, every relative figure is derived from integers the
// loader already stamped, and every colour and bar width is resolved here so
// ./campaigns-panel.tsx stays a plain mapper.
//
// THREE SOURCES, AND THE PAGE ALWAYS SAYS WHICH ONE IT IS READING.
//
//   * EMAIL EVENTS (migrations/0022) — one stored row per email Smartlead has
//     reported: when it was sent, opened, clicked and replied to, whether the
//     lead's sentiment category is a positive one, whether it bounced. This is
//     the good source, and when a campaign has been synced since that migration
//     it is what every headline figure, the daily chart and the step table read.
//     Counts are UNIQUE LEADS, matching Smartlead's own reporting: a lead who
//     opened eight times is one open.
//
//   * CONTACTS — the progress breakdown, and the fallback chart. This is a CRM
//     question, not a Smartlead one ("how far through the sequence is my book"),
//     so it is answered from the contact's own touchpoints and pipeline status
//     even when events are available. Campaign sends are told from a rep's
//     hand-logged email touch by their note prefix — see SEND_NOTE_PREFIX — which
//     is the only signal there is, because a touchpoint has no direction and no
//     source column. The breakdown counts the leads PUSHED to the campaign
//     (migration 0009's smartlead_leads, arriving as `pushedContactIds`), not
//     every contact on the loop — see the cohort note in buildLoop().
//
//   * TEMPLATE VARIANT COUNTERS (migrations/0008) — absolute lifetime totals
//     pushed by the stats sync. Used for the step table ONLY as a fallback, for a
//     campaign not yet synced since 0022. They carry meetings, which events do
//     not (Smartlead has no meeting concept), and they carry no clicks at all.
//
// The fallback matters: without it, every campaign would read as zero until its
// next sync, which looks exactly like a campaign that has stopped working.

import { CH, type Contact, ownerAvatar, statusMeta } from "./data";

/**
 * The note prefix every campaign send touchpoint carries, written by
 * recordContactSends() in app/lib/crm.server.ts ("Sent by X" / "Sent step N of
 * X"). Imported by that writer rather than duplicated, so the two halves of this
 * contract cannot drift: change the prefix there and the constant moves with it.
 */
export const SEND_NOTE_PREFIX = "Sent ";

/** The mirror of the above, written by recordReplies() ("Replied from X"). */
export const REPLY_NOTE_PREFIX = "Replied";

/** Statuses that imply the contact replied at some point. Mirrors ./analytics.ts. */
const REPLIED = new Set(["Replied", "Meeting booked", "Won"]);
/** Statuses that imply a meeting was booked. */
const MEETING = new Set(["Meeting booked", "Won"]);

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

/** A rate that distinguishes "0%" from "no data" — null renders as a dash. */
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

/** Bar width, clamped so a single contact still paints a visible sliver. */
const barWidth = (count: number, total: number): string =>
  count > 0 ? `${Math.max(pct(count, total), 1.5)}%` : "0%";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Loader contract
// ---------------------------------------------------------------------------

/**
 * One sequence step, resolved by the loader against buildSequencePlan() and the
 * template it points at. The counters are the FALLBACK figures — the sum of the
 * variant counters over the slots this step uploads. When the campaign has
 * events, the step's numbers come from those instead, keyed on `seqNumber`.
 */
export type CampaignStepInput = {
  seqNumber: number;
  templateId: string;
  name: string;
  /** The step's pinned slot, or null for an A/B split of every slot with copy. */
  variantSlot: string | null;
  /** Slot letters actually uploaded, e.g. ["A", "B"]. */
  slots: string[];
  /** Running total of the waits up to this step, for the "Day N" chip. */
  dayOffset: number;
  /** First line of the copy, for the caption under the step name. */
  subject: string;
  sends: number;
  opens: number;
  replies: number;
  meetings: number;
};

/**
 * The stored email events for one campaign, already aggregated in SQL.
 *
 * Structurally the `CampaignEventStats` readCampaignEventStats() returns; typed
 * again here so this module keeps its no-server-imports rule. Null means the
 * campaign has no stored rows — never synced since migration 0022 — which is a
 * different thing from a campaign that has genuinely sent nothing.
 */
export type CampaignEventInput = {
  totals: {
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
  steps: {
    sequenceNumber: number;
    emails: number;
    opened: number;
    clicked: number;
    replied: number;
  }[];
  /** `YYYY-MM-DD` UTC days, ascending. Joined onto `dayKeys` by string. */
  days: { day: string; sent: number; opened: number; clicked: number }[];
};

/** Everything the loader knows about one loop's campaign, before aggregation. */
export type CampaignLoopInput = {
  loop: number;
  /** Null when no Smartlead campaign is bound to this loop. */
  campaignName: string | null;
  /** How many contacts have been handed to the campaign as leads. */
  leadsPushed: number;
  /**
   * The contact ids behind that count — the cohort the progress breakdown is
   * about. Null means no campaign is bound, which the aggregator must tell from
   * an empty array: a bound campaign nobody has pushed to has a cohort of zero
   * leads, not a cohort of everyone on the loop.
   */
  pushedContactIds: string[] | null;
  sequencePushedLabel: string | null;
  leadsPushedLabel: string | null;
  statsSyncedLabel: string | null;
  steps: CampaignStepInput[];
  events: CampaignEventInput | null;
};

export type CampaignsInput = {
  /** "Jul 16"-style day labels, oldest first. Shared with ./analytics.ts. */
  dayLabels: string[];
  /** The same axis as `YYYY-MM-DD` UTC dates, for the event join. */
  dayKeys: string[];
  loops: CampaignLoopInput[];
};

// ---------------------------------------------------------------------------
// View contract
// ---------------------------------------------------------------------------

export type CampaignKpi = {
  key: string;
  label: string;
  value: string;
  sub: string;
  /** Accent for the figure; the neutral ink for a count with no rate behind it. */
  color: string;
};

export type ProgressRow = {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
  barWidth: string;
};

export type CampaignSeries = { key: string; label: string; color: string; count: number };
export type CampaignDay = {
  label: string;
  /** One entry per series, in `series` order. Zero-height bars are kept so the
   *  column keeps its shape and a quiet day is visibly quiet rather than absent. */
  bars: { key: string; color: string; height: string; count: number }[];
  total: number;
};
export type CampaignChart = {
  days: CampaignDay[];
  series: CampaignSeries[];
  total: number;
  startLabel: string;
  endLabel: string;
  /** What the bars are counted from, so the panel's caption can't misdescribe them. */
  caption: string;
};

export type CampaignStepRow = {
  key: string;
  seqNumber: number;
  name: string;
  variantLabel: string;
  dayLabel: string;
  subject: string;
  sends: number;
  opens: number;
  /** Null when the figures come from variant counters, which have no clicks. */
  clicks: number | null;
  replies: number;
  /** Null when the figures come from events, which have no meeting concept. */
  meetings: number | null;
  openRate: number | null;
  clickRate: number | null;
  replyRate: number | null;
  meetingRate: number | null;
  /** Banded from the reply rate — see stepVerdict(). */
  verdict: string;
  verdictStyle: string;
};

export type CampaignOwnerRow = {
  key: string;
  label: string;
  initial: string;
  color: string;
  hasAvatar: boolean;
  contacts: number;
  sends: number;
  replied: number;
  replyRate: number | null;
};

export type CampaignLoopView = {
  loop: number;
  title: string;
  descriptor: string;
  subtitle: string;
  /** The campaign name, or the "not linked" notice. */
  badge: { label: string; style: string };
  /** Contacts on this loop. The empty state reads this; `progress` does not. */
  contacts: number;
  /** Whether the headline figures came from stored email events. */
  fromEvents: boolean;
  progress: {
    pctComplete: number;
    processed: number;
    capacity: number;
    /**
     * The denominator of every row: the leads pushed to the campaign, or the
     * loop's contacts when no campaign is bound. NOT `contacts` — see the
     * cohort note in buildLoop().
     */
    total: number;
    caption: string;
    rows: ProgressRow[];
  };
  kpis: CampaignKpi[];
  /** Bounces and unsubscribes, or null when there are no events to read them from. */
  deliverability: string | null;
  chart: CampaignChart;
  steps: CampaignStepRow[];
  /** Where the step table's numbers came from, printed under it. */
  stepsCaption: string;
  owners: CampaignOwnerRow[];
  /** One line about how fresh these figures are, or why they are all zero. */
  freshness: string;
};

export type CampaignsView = { loops: CampaignLoopView[] };

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const INK = "#1a1a1a";
const SEND_COLOR = CH.email.fg; // the app's one blue for "an email happened"
const OPEN_COLOR = "#6d3fc4";
const CLICK_COLOR = "#0a7ea4";
const REPLY_COLOR = statusMeta("Replied").dot;
const MEETING_COLOR = statusMeta("Meeting booked").dot;
const POSITIVE_COLOR = "#1f7a4d";
const MUTED = "#a3a39d";
const WARN = "#9a5b5b";

/**
 * The progress buckets, in the order the panel lists them. Evaluation order is
 * NOT this order — see classify() — but display order is, because a reader scans
 * a funnel from "furthest along" down to "not started".
 */
const PROGRESS_BUCKETS = [
  { key: "finished", label: "Finished the sequence", color: "#b0705a" },
  { key: "inProgress", label: "In progress", color: SEND_COLOR },
  { key: "replied", label: "Replied and stopped", color: REPLY_COLOR },
  { key: "yetToStart", label: "Yet to start", color: MUTED },
  { key: "noEmail", label: "No email on file", color: WARN },
] as const;

type BucketKey = (typeof PROGRESS_BUCKETS)[number]["key"];

// ---------------------------------------------------------------------------
// Per-contact reads
// ---------------------------------------------------------------------------

/**
 * How many campaign emails this contact has been sent, as observed by the stats
 * sync. Not the number of steps in the sequence and not the number of leads
 * pushed: a pushed lead a paused campaign never reached counts zero here, which
 * is the whole point of migration 0015.
 */
export function campaignSends(contact: Contact): number {
  let n = 0;
  for (const t of contact.touches) {
    if (t.ch === "email" && t.note.startsWith(SEND_NOTE_PREFIX)) n++;
  }
  return n;
}

/**
 * Which progress bucket a contact falls in. Evaluated in an order the display
 * order does not imply, and the order is the whole correctness argument:
 *
 *   1. A reply stops the sequence in Smartlead, so someone who answered is
 *      "replied and stopped" no matter how many steps they had received.
 *   2. Then no email on file — nothing can ever be sent to them, and reporting
 *      them as "yet to start" would suggest the campaign will get to them.
 *   3. Then the send count against the sequence length.
 *
 * `steps === 0` means there is no sequence to finish, so every contacted person
 * is "in progress" rather than falsely complete.
 */
function classify(contact: Contact, sends: number, steps: number): BucketKey {
  if (REPLIED.has(contact.status)) return "replied";
  if (!contact.email) return "noEmail";
  if (sends === 0) return "yetToStart";
  if (steps > 0 && sends >= steps) return "finished";
  return "inProgress";
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** Shared tail of both chart builders: bar heights, totals and the axis labels. */
function assembleChart(
  dayLabels: string[],
  series: { key: string; label: string; color: string; values: number[] }[],
  caption: string,
): CampaignChart {
  // Floor of 1 keeps the height division safe on an empty window.
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const totals = series.map((s) => s.values.reduce((n, v) => n + v, 0));

  return {
    days: dayLabels.map((label, i) => ({
      label,
      total: series.reduce((n, s) => n + s.values[i], 0),
      bars: series.map((s) => ({
        key: s.key,
        color: s.color,
        height: `${(s.values[i] / max) * 100}%`,
        count: s.values[i],
      })),
    })),
    series: series.map((s, i) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      count: totals[i],
    })),
    total: totals.reduce((n, v) => n + v, 0),
    startLabel: dayLabels[0] ?? "",
    endLabel: dayLabels[dayLabels.length - 1] ?? "",
    caption,
  };
}

/**
 * Sends, opens and clicks per day, from the stored events.
 *
 * The join is `dayKeys[i]` against the event row's `day`, both `YYYY-MM-DD` UTC
 * — buildAnalyticsLabels() emits the first and readCampaignEventStats() groups on
 * the second by taking the first ten characters of Smartlead's ISO timestamps.
 * Days outside the window simply don't match, which is the correct behaviour: an
 * event older than the axis belongs off the left edge, not piled onto the first
 * column.
 */
function eventChart(
  events: CampaignEventInput,
  dayLabels: string[],
  dayKeys: string[],
): CampaignChart {
  const byDay = new Map(events.days.map((d) => [d.day, d]));
  const pick = (get: (d: CampaignEventInput["days"][number]) => number) =>
    dayKeys.map((key) => {
      const row = byDay.get(key);
      return row ? get(row) : 0;
    });

  return assembleChart(
    dayLabels,
    [
      { key: "sent", label: "Sent", color: SEND_COLOR, values: pick((d) => d.sent) },
      { key: "opened", label: "Opened", color: OPEN_COLOR, values: pick((d) => d.opened) },
      { key: "clicked", label: "Clicked", color: CLICK_COLOR, values: pick((d) => d.clicked) },
    ],
    "One bar per email Smartlead reported, on the day it was sent, opened or clicked. " +
      "An email counts on each of the three days it earns, so the series are not a funnel.",
  );
}

/**
 * The fallback chart, for a campaign with no stored events yet.
 *
 * Built from the contact's own touchpoints, which is all the CRM had before
 * migration 0022 — and which can only ever show sends and replies, since an open
 * is not something we did and was never written as a touch.
 *
 * `dayLabels[i]` is (len - 1 - i) days ago, the exact inverse of the `daysAgo`
 * listContacts stamps and the same alignment ./analytics.ts relies on.
 */
function touchChart(contacts: Contact[], dayLabels: string[]): CampaignChart {
  const span = dayLabels.length;
  const sends = dayLabels.map(() => 0);
  const replies = dayLabels.map(() => 0);

  for (const c of contacts) {
    for (const t of c.touches) {
      if (t.daysAgo < 0 || t.daysAgo >= span) continue;
      const i = span - 1 - t.daysAgo;
      if (t.ch === "email" && t.note.startsWith(SEND_NOTE_PREFIX)) sends[i]++;
      else if (t.note.startsWith(REPLY_NOTE_PREFIX)) replies[i]++;
    }
  }

  return assembleChart(
    dayLabels,
    [
      { key: "sent", label: "Sent", color: SEND_COLOR, values: sends },
      { key: "replied", label: "Replied", color: REPLY_COLOR, values: replies },
    ],
    "Counted from contact touchpoints, because this campaign has no stored email rows yet. " +
      "Opens and clicks appear here after the next stats sync.",
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The engagement tag beside a step.
 *
 * Bands over the step's own reply rate, not a comparison against the other steps:
 * a two-step sequence would otherwise always have one "high" and one "low" step
 * however well or badly both performed. The thresholds are ours and deliberately
 * coarse — anything finer would imply a confidence these figures cannot carry.
 * ./ab.ts holds the only real statistics in the app; this is a label, not a
 * verdict on a test.
 */
function stepVerdict(sends: number, replies: number): { verdict: string; verdictStyle: string } {
  const chip =
    "display:inline-flex; align-items:center; padding:2px 8px; border-radius:6px; font-size:11.5px; font-weight:500;";
  if (sends === 0) return { verdict: "No sends yet", verdictStyle: chip + `color:${MUTED};` };
  const r = (replies / sends) * 100;
  if (r >= 10) return { verdict: "High engagement", verdictStyle: chip + `color:${POSITIVE_COLOR};` };
  if (r >= 3) return { verdict: "Steady", verdictStyle: chip + "color:#575753;" };
  if (r > 0) return { verdict: "Low engagement", verdictStyle: chip + `color:${WARN};` };
  return { verdict: "No replies yet", verdictStyle: chip + `color:${MUTED};` };
}

function buildSteps(
  steps: CampaignStepInput[],
  events: CampaignEventInput | null,
): CampaignStepRow[] {
  // Keyed on Smartlead's sequence number, which is exactly what the plan's
  // seqNumber is — buildSequencePlan() assigns it and the sync reads it back.
  const bySeq = new Map((events?.steps ?? []).map((s) => [s.sequenceNumber, s]));

  return steps.map((s) => {
    const observed = events ? bySeq.get(s.seqNumber) : undefined;
    // An A/B step gets real numbers here and cannot on the counters: the stats
    // sync refuses to attribute a split step to one variant, but an event row
    // carries its own sequence_number and needs no attribution at all.
    const sends = observed ? observed.emails : s.sends;
    const opens = observed ? observed.opened : s.opens;
    const replies = observed ? observed.replied : s.replies;
    const clicks = observed ? observed.clicked : null;
    const meetings = observed ? null : s.meetings;

    return {
      key: `${s.seqNumber}:${s.templateId}:${s.variantSlot ?? "split"}`,
      seqNumber: s.seqNumber,
      name: s.name,
      variantLabel:
        s.variantSlot ?? (s.slots.length > 1 ? `A/B · ${s.slots.join("+")}` : (s.slots[0] ?? "-")),
      dayLabel: s.dayOffset === 0 ? "Day 0" : `Day ${s.dayOffset}`,
      subject: s.subject,
      sends,
      opens,
      clicks,
      replies,
      meetings,
      openRate: rate(opens, sends),
      clickRate: clicks === null ? null : rate(clicks, sends),
      replyRate: rate(replies, sends),
      meetingRate: meetings === null ? null : rate(meetings, sends),
      ...stepVerdict(sends, replies),
    };
  });
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/**
 * Sending split by the contact's owner. `sends` is campaign sends, not every
 * touchpoint: this table answers "who is the campaign working through", and a
 * rep's logged calls have no place in that number.
 *
 * Deliberately contact-based even when events exist — an event row records an
 * address, not a person, and ownership is a CRM fact.
 */
function buildOwners(contacts: Contact[], sendsByContact: Map<string, number>): CampaignOwnerRow[] {
  const acc = new Map<string, { contacts: number; sends: number; replied: number }>();
  for (const c of contacts) {
    const key = c.owner || "";
    const row = acc.get(key) ?? { contacts: 0, sends: 0, replied: 0 };
    row.contacts++;
    row.sends += sendsByContact.get(c.id) ?? 0;
    if (REPLIED.has(c.status)) row.replied++;
    acc.set(key, row);
  }
  return [...acc.entries()]
    .map(([key, v]) => {
      const avatar = ownerAvatar(key);
      return {
        key: key || "unassigned",
        label: key || "Unassigned",
        initial: avatar.initial,
        color: avatar.color,
        hasAvatar: Boolean(key),
        contacts: v.contacts,
        sends: v.sends,
        replied: v.replied,
        // Over contacts, not over sends: the question is what share of this
        // owner's book answered, and a send is not a person.
        replyRate: rate(v.replied, v.contacts),
      };
    })
    // Unassigned last regardless of size — it's a to-do, not a performer. Explicit
    // tiebreaks throughout: an unstable order is a hydration mismatch.
    .sort(
      (a, b) =>
        Number(b.hasAvatar) - Number(a.hasAvatar) ||
        b.sends - a.sends ||
        b.contacts - a.contacts ||
        a.label.localeCompare(b.label),
    );
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/**
 * The line under the completion percentage, which has to name the cohort it
 * divided by — "320 of 348" is only readable once the reader knows 348 is the
 * pushed book and not the loop.
 *
 * Every branch below is a different reason the percentage is missing, and they
 * are worth telling apart: nothing pushed, nothing built, and nobody with an
 * address are three different next actions.
 */
function progressCaption(
  processed: number,
  capacity: number,
  cohortTotal: number,
  stepCount: number,
  pushed: boolean,
): string {
  const cohortNote = pushed
    ? `across ${plural(cohortTotal, "pushed lead")}`
    : `across ${plural(cohortTotal, "contact")} on this loop`;
  if (capacity > 0) return `${processed} of ${capacity} sends processed ${cohortNote}`;
  if (cohortTotal === 0) {
    return pushed
      ? "No leads have been pushed to this campaign yet."
      : "No contacts on this loop yet.";
  }
  if (stepCount === 0) return "No sequence steps built yet, so there is nothing to complete.";
  return pushed
    ? "None of the pushed leads has an email address."
    : "No contacts on this loop have an email address.";
}

function buildLoop(
  contacts: Contact[],
  input: CampaignLoopInput,
  dayLabels: string[],
  dayKeys: string[],
): CampaignLoopView {
  const loop = input.loop;
  const inLoop = contacts.filter((c) => c.loops.includes(loop));
  const total = inLoop.length;
  const stepCount = input.steps.length;
  const events = input.events;

  const sendsByContact = new Map<string, number>();
  const sendsOf = (c: Contact): number => {
    const cached = sendsByContact.get(c.id);
    if (cached !== undefined) return cached;
    const n = campaignSends(c);
    sendsByContact.set(c.id, n);
    return n;
  };

  /*
   * WHO "CAMPAIGN PROGRESS" IS ABOUT: the leads pushed to the campaign, not
   * every contact sitting on the loop.
   *
   * The panel answers "how far has this campaign worked through what it was
   * given". A contact that was never pushed was never given to it, so counting
   * them made a campaign holding 348 leads report 320 of 801 — a sequence that
   * is most of the way through its book read as barely started, and the gap grew
   * every time someone added a contact the campaign had never heard of. The
   * cohort is the pushed set and every denominator below comes from it.
   *
   * The pushed set is authoritative and is deliberately NOT intersected with
   * loop membership: a contact taken off the loop after being pushed is still a
   * lead the campaign holds and still receives its emails, and dropping them
   * would put the count back below the number of sends that actually went out.
   *
   * `null` (no campaign bound) falls back to the loop's contacts, because
   * "0 of 0" would be a worse answer than the book this loop would push if it
   * were linked — and the badge already says it is linked to nothing. A bound
   * campaign with an empty cohort is a different thing and does read as zero.
   */
  const pushedIds = input.pushedContactIds;
  const pushedSet = pushedIds ? new Set(pushedIds) : null;
  const cohort = pushedSet ? contacts.filter((c) => pushedSet.has(c.id)) : inLoop;
  const cohortTotal = cohort.length;

  const counts: Record<BucketKey, number> = {
    finished: 0,
    inProgress: 0,
    replied: 0,
    yetToStart: 0,
    noEmail: 0,
  };
  let processed = 0;
  let cohortWithEmail = 0;

  for (const c of cohort) {
    const sends = sendsOf(c);
    processed += sends;
    if (c.email) cohortWithEmail++;
    counts[classify(c, sends, stepCount)]++;
  }

  // The loop's own figures, which the KPI tiles fall back to when there are no
  // events. Kept over the loop rather than the cohort: those tiles are labelled
  // "on this loop", and a lead pushed from another loop is not one of them.
  let contactedInCrm = 0;
  let withEmail = 0;
  let repliedInCrm = 0;
  for (const c of inLoop) {
    if (sendsOf(c) > 0) contactedInCrm++;
    if (c.email) withEmail++;
    if (REPLIED.has(c.status)) repliedInCrm++;
  }

  const meetings = inLoop.filter((c) => MEETING.has(c.status)).length;
  // What a fully-run sequence would amount to: every PUSHED lead that could be
  // emailed, times the steps it would receive. Zero steps means the sequence is
  // unknown, and a percentage against an unknown denominator is worse than none.
  const capacity = stepCount * cohortWithEmail;

  // The headline row. With events every figure is Smartlead's own unique-lead
  // count; without them it falls back to what the CRM can see for itself, which
  // is the same set of questions answered from a poorer source.
  const contacted = events ? events.totals.sent : contactedInCrm;
  const replied = events ? events.totals.replied : repliedInCrm;

  const badgeChip =
    "display:inline-flex; align-items:center; padding:3px 9px; border-radius:6px; font-size:11.5px; font-weight:500; white-space:nowrap;";
  const badge = input.campaignName
    ? { label: input.campaignName, style: badgeChip + "background:#e4f3ea; color:#1f7a4d;" }
    : { label: "Not linked to a campaign", style: badgeChip + `background:#f2f2f0; color:${MUTED};` };

  const descriptor = loop === 2 ? "Event/community blitz" : "Always-on outbound";

  const kpis: CampaignKpi[] = [
    {
      key: "contacted",
      label: "Leads contacted",
      value: String(contacted),
      sub: `${total} on this loop`,
      color: INK,
    },
    {
      key: "opened",
      label: "Opened",
      value: events ? String(events.totals.opened) : "-",
      sub: events
        ? contacted
          ? `${pct(events.totals.opened, contacted)}% open rate`
          : "no sends yet"
        : "needs a stats sync",
      color: OPEN_COLOR,
    },
    {
      key: "clicked",
      label: "Clicked",
      value: events ? String(events.totals.clicked) : "-",
      sub: events
        ? contacted
          ? `${pct(events.totals.clicked, contacted)}% click rate`
          : "no sends yet"
        : "needs a stats sync",
      color: CLICK_COLOR,
    },
    {
      key: "replied",
      label: "Replied",
      value: String(replied),
      sub: contacted ? `${pct(replied, contacted)}% reply rate` : "no contacted leads yet",
      color: REPLY_COLOR,
    },
    events
      ? {
          key: "positive",
          label: "Positive replies",
          value: String(events.totals.positive),
          // Smartlead's own sentiment categories, not a judgement made here. A
          // team that never categorises its replies sees zero, which is the
          // truth about the categorisation rather than about the replies.
          sub: replied
            ? `${pct(events.totals.positive, replied)}% of replies`
            : "no replies yet",
          color: POSITIVE_COLOR,
        }
      : {
          key: "meetings",
          label: "Meetings booked",
          value: String(meetings),
          sub: replied ? `${pct(meetings, replied)}% of replies` : "no replies yet",
          color: MEETING_COLOR,
        },
    {
      key: "noEmail",
      label: "No email",
      value: String(total - withEmail),
      sub: total ? `${pct(total - withEmail, total)}% of the loop` : "no contacts yet",
      color: WARN,
    },
  ];

  // The freshness line is the honest answer to "why is everything zero", which is
  // almost always one of three things and never worth making the reader guess.
  const freshness = !input.campaignName
    ? "Link this loop to a Smartlead campaign on the Smartlead page to start recording sends."
    : input.statsSyncedLabel
      ? `Figures are as of the last Smartlead stats sync on ${input.statsSyncedLabel}. Press Sync stats on the Smartlead page to bring them forward.`
      : "This campaign has never been synced — press Sync stats on the Smartlead page to pull in what it has sent.";

  return {
    loop,
    title: loop === 2 ? "Loop 2 blitz" : "Loop 1 outbound",
    descriptor,
    subtitle: `${descriptor} · ${plural(stepCount, "sequence step")} · ${plural(input.leadsPushed, "lead")} pushed`,
    badge,
    contacts: total,
    fromEvents: Boolean(events),
    progress: {
      pctComplete: pct(processed, capacity),
      processed,
      capacity,
      total: cohortTotal,
      caption: progressCaption(processed, capacity, cohortTotal, stepCount, Boolean(pushedSet)),
      rows: PROGRESS_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        count: counts[b.key],
        pct: pct(counts[b.key], cohortTotal),
        color: b.color,
        barWidth: barWidth(counts[b.key], cohortTotal),
      })),
    },
    kpis,
    deliverability: events
      ? `${plural(events.totals.bounced, "bounce", "bounces")} · ` +
        `${events.totals.unsubscribed} unsubscribed · ` +
        `${plural(events.totals.emails, "email")} recorded across ${plural(events.totals.leads, "lead")}`
      : null,
    chart: events ? eventChart(events, dayLabels, dayKeys) : touchChart(inLoop, dayLabels),
    steps: buildSteps(input.steps, events),
    stepsCaption: events
      ? "Counted from the emails Smartlead reported for each step, so an A/B step gets real numbers here even though the template counters can't be split."
      : "From the template's variant counters, which the stats sync writes as absolute lifetime totals. Clicks aren't among them — sync this campaign to read per-step clicks.",
    owners: buildOwners(inLoop, sendsByContact),
    freshness,
  };
}

export function computeCampaigns(contacts: Contact[], input: CampaignsInput): CampaignsView {
  return {
    loops: input.loops.map((l) => buildLoop(contacts, l, input.dayLabels, input.dayKeys)),
  };
}
