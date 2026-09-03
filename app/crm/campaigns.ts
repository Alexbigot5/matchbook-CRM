// Campaign aggregation for the /analytics page's "Email campaigns" tab.
//
// Pure and isomorphic, the same contract as ./analytics.ts and ./ab.ts: no React,
// no server imports, and — critically — no `Date`. Every absolute label arrives
// precomputed from the loader, every relative figure is derived from the
// `daysAgo` integers listContacts already stamped, and every colour and bar width
// is resolved here so ./campaigns-panel.tsx stays a plain mapper.
//
// WHERE THE NUMBERS COME FROM. This tab reads two different sources and they are
// not interchangeable, so the page says which is which:
//
//   * PER CONTACT — how many emails the campaign has actually sent to a given
//     person, and whether they answered. That lives on the contact: the Smartlead
//     stats sync writes one `email` touchpoint per observed send (migration 0015)
//     and the Unipile sync writes one per reply (migration 0021). Both are
//     recognised here by their note prefix — see SEND_NOTE_PREFIX below — which is
//     what lets a rep's own hand-logged "Log touch" email stay out of a campaign
//     figure. This is what the progress breakdown, the daily chart and the owner
//     table are built from.
//
//   * PER SEQUENCE STEP — sends/opens/replies/meetings as absolute lifetime
//     totals on `template_variants`, pushed by the stats sync. Opens exist ONLY
//     here: nothing records an open as an event, so there is no per-contact and no
//     per-day open figure and this module deliberately invents neither. The step
//     table is the only place those counters are read.
//
// Two things this file will not do, because the data to do them honestly does not
// exist: there is no click counter anywhere in the schema (see
// migrations/0008_email_templates.sql — the four counters are sends, opens,
// replies, meetings), and nothing classifies a reply as positive or negative. A
// tile for either would be a number with no source behind it.

import { CH, type Contact, ownerAvatar, statusMeta } from "./data";

/**
 * The note prefix every campaign send touchpoint carries, written by
 * recordContactSends() in app/lib/crm.server.ts ("Sent by X" / "Sent step N of
 * X"). Imported by that writer rather than duplicated, so the two halves of this
 * contract cannot drift: change the prefix there and the constant moves with it.
 *
 * Matching on the note is what separates a campaign send from a rep pressing "Log
 * touch" on the email chip, which the touchpoints table has no column to tell
 * apart — there is no direction and no source column on a touchpoint.
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
 * One sequence step, already resolved by the loader against buildSequencePlan()
 * and the template it points at. The counters are the sum over the slots this
 * step actually uploads, which is one variant for a pinned step and both for an
 * A/B split — the same grouping the stats sync writes them back under.
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

/** Everything the loader knows about one loop's campaign, before aggregation. */
export type CampaignLoopInput = {
  loop: number;
  /** Null when no Smartlead campaign is bound to this loop. */
  campaignName: string | null;
  /** How many contacts have been handed to the campaign as leads. */
  leadsPushed: number;
  sequencePushedLabel: string | null;
  leadsPushedLabel: string | null;
  statsSyncedLabel: string | null;
  steps: CampaignStepInput[];
};

export type CampaignsInput = {
  /** "Jul 16"-style day labels, oldest first. Shared with ./analytics.ts. */
  dayLabels: string[];
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
  replies: number;
  meetings: number;
  openRate: number | null;
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
  /** Contacts on this loop, the denominator of every share below. */
  contacts: number;
  progress: {
    pctComplete: number;
    processed: number;
    capacity: number;
    caption: string;
    rows: ProgressRow[];
  };
  kpis: CampaignKpi[];
  chart: CampaignChart;
  steps: CampaignStepRow[];
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
const REPLY_COLOR = statusMeta("Replied").dot;
const MEETING_COLOR = statusMeta("Meeting booked").dot;
const OPEN_COLOR = "#6d3fc4";
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
// Builders
// ---------------------------------------------------------------------------

/**
 * Daily campaign sends and replies over the label window.
 *
 * `dayLabels[i]` is (len - 1 - i) days ago — the exact inverse of the `daysAgo`
 * listContacts stamps, the same alignment ./analytics.ts relies on. Touches
 * outside the window are dropped rather than clamped into an edge column, so the
 * first bar is never a pile of everything older.
 *
 * Bars are grouped rather than stacked: a send and a reply are different events
 * about different people, and stacking them would read as one volume.
 */
function buildChart(contacts: Contact[], dayLabels: string[]): CampaignChart {
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

  const sendTotal = sends.reduce((s, n) => s + n, 0);
  const replyTotal = replies.reduce((s, n) => s + n, 0);
  // Floor of 1 keeps the height division safe on an empty window.
  const max = Math.max(1, ...sends, ...replies);

  const series: CampaignSeries[] = [
    { key: "sent", label: "Sent", color: SEND_COLOR, count: sendTotal },
    { key: "replied", label: "Replied", color: REPLY_COLOR, count: replyTotal },
  ];

  return {
    days: dayLabels.map((label, i) => ({
      label,
      total: sends[i] + replies[i],
      bars: [
        { key: "sent", color: SEND_COLOR, height: `${(sends[i] / max) * 100}%`, count: sends[i] },
        {
          key: "replied",
          color: REPLY_COLOR,
          height: `${(replies[i] / max) * 100}%`,
          count: replies[i],
        },
      ],
    })),
    series,
    total: sendTotal + replyTotal,
    startLabel: dayLabels[0] ?? "",
    endLabel: dayLabels[dayLabels.length - 1] ?? "",
  };
}

/**
 * The engagement tag beside a step.
 *
 * Bands over the step's own reply rate, not a comparison against the other steps:
 * a two-step sequence would otherwise always have one "high" and one "low" step
 * however well or badly both performed. The thresholds are ours and deliberately
 * coarse — anything finer would imply a confidence these counters cannot carry
 * (they are absolute lifetime totals with no denominator for time). ./ab.ts holds
 * the only real statistics in the app; this is a label, not a verdict on a test.
 */
function stepVerdict(sends: number, replies: number): { verdict: string; verdictStyle: string } {
  const chip =
    "display:inline-flex; align-items:center; padding:2px 8px; border-radius:6px; font-size:11.5px; font-weight:500;";
  if (sends === 0) return { verdict: "No sends yet", verdictStyle: chip + `color:${MUTED};` };
  const r = (replies / sends) * 100;
  if (r >= 10) return { verdict: "High engagement", verdictStyle: chip + "color:#1f7a4d;" };
  if (r >= 3) return { verdict: "Steady", verdictStyle: chip + "color:#575753;" };
  if (r > 0) return { verdict: "Low engagement", verdictStyle: chip + `color:${WARN};` };
  return { verdict: "No replies yet", verdictStyle: chip + `color:${MUTED};` };
}

function buildSteps(steps: CampaignStepInput[]): CampaignStepRow[] {
  return steps.map((s) => ({
    key: `${s.seqNumber}:${s.templateId}:${s.variantSlot ?? "split"}`,
    seqNumber: s.seqNumber,
    name: s.name,
    variantLabel: s.variantSlot ?? (s.slots.length > 1 ? `A/B · ${s.slots.join("+")}` : s.slots[0] ?? "-"),
    dayLabel: s.dayOffset === 0 ? "Day 0" : `Day ${s.dayOffset}`,
    subject: s.subject,
    sends: s.sends,
    opens: s.opens,
    replies: s.replies,
    meetings: s.meetings,
    openRate: rate(s.opens, s.sends),
    replyRate: rate(s.replies, s.sends),
    meetingRate: rate(s.meetings, s.sends),
    ...stepVerdict(s.sends, s.replies),
  }));
}

/**
 * Sending split by the contact's owner. `sends` is campaign sends, not every
 * touchpoint: this table answers "who is the campaign working through", and a
 * rep's logged calls have no place in that number.
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

function buildLoop(
  contacts: Contact[],
  input: CampaignLoopInput,
  dayLabels: string[],
): CampaignLoopView {
  const loop = input.loop;
  const inLoop = contacts.filter((c) => c.loops.includes(loop));
  const total = inLoop.length;
  const stepCount = input.steps.length;

  const sendsByContact = new Map<string, number>();
  const counts: Record<BucketKey, number> = {
    finished: 0,
    inProgress: 0,
    replied: 0,
    yetToStart: 0,
    noEmail: 0,
  };
  let processed = 0;
  let contacted = 0;
  let withEmail = 0;
  let replies = 0;

  for (const c of inLoop) {
    const sends = campaignSends(c);
    sendsByContact.set(c.id, sends);
    processed += sends;
    if (sends > 0) contacted++;
    if (c.email) withEmail++;
    if (REPLIED.has(c.status)) replies++;
    counts[classify(c, sends, stepCount)]++;
  }

  const meetings = inLoop.filter((c) => MEETING.has(c.status)).length;
  // What a fully-run sequence would amount to: every contact that could be
  // emailed, times the steps it would receive. Zero steps means the sequence is
  // unknown, and a percentage against an unknown denominator is worse than none.
  const capacity = stepCount * withEmail;
  const stepSends = input.steps.reduce((s, x) => s + x.sends, 0);
  const stepOpens = input.steps.reduce((s, x) => s + x.opens, 0);

  const badgeChip =
    "display:inline-flex; align-items:center; padding:3px 9px; border-radius:6px; font-size:11.5px; font-weight:500; white-space:nowrap;";
  const badge = input.campaignName
    ? { label: input.campaignName, style: badgeChip + "background:#e4f3ea; color:#1f7a4d;" }
    : { label: "Not linked to a campaign", style: badgeChip + `background:#f2f2f0; color:${MUTED};` };

  const descriptor = loop === 2 ? "Event/community blitz" : "Always-on outbound";

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
    progress: {
      pctComplete: pct(processed, capacity),
      processed,
      capacity,
      caption:
        capacity > 0
          ? `${processed} of ${capacity} sends processed`
          : stepCount === 0
            ? "No sequence steps built yet, so there is nothing to complete."
            : "No contacts on this loop have an email address.",
      rows: PROGRESS_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        count: counts[b.key],
        pct: pct(counts[b.key], total),
        color: b.color,
        barWidth: barWidth(counts[b.key], total),
      })),
    },
    kpis: [
      {
        key: "contacted",
        label: "Leads contacted",
        value: String(contacted),
        sub: `${total} on this loop`,
        color: INK,
      },
      {
        key: "sends",
        label: "Sends logged",
        value: String(processed),
        sub: contacted ? `${(processed / contacted).toFixed(1)} per contacted lead` : "none yet",
        color: SEND_COLOR,
      },
      {
        key: "opens",
        label: "Opened",
        value: String(stepOpens),
        // Opens have no per-contact record, so this rate is over the step
        // counters' own sends — a different denominator from "sends logged" above,
        // which is why the panel caption names both sources.
        sub: stepSends ? `${pct(stepOpens, stepSends)}% of ${stepSends} step sends` : "no step figures yet",
        color: OPEN_COLOR,
      },
      {
        key: "replied",
        label: "Replied",
        value: String(replies),
        sub: contacted ? `${pct(replies, contacted)}% reply rate` : "no contacted leads yet",
        color: REPLY_COLOR,
      },
      {
        key: "meetings",
        label: "Meetings booked",
        value: String(meetings),
        sub: replies ? `${pct(meetings, replies)}% of replies` : "no replies yet",
        color: MEETING_COLOR,
      },
      {
        key: "noEmail",
        label: "No email",
        value: String(total - withEmail),
        sub: total ? `${pct(total - withEmail, total)}% of the loop` : "no contacts yet",
        color: WARN,
      },
    ],
    chart: buildChart(inLoop, dayLabels),
    steps: buildSteps(input.steps),
    owners: buildOwners(inLoop, sendsByContact),
    freshness,
  };
}

/** Also used by the panel's empty state, so the two agree on what "no data" is. */
export function hasCampaignData(view: CampaignLoopView): boolean {
  return view.contacts > 0 || view.steps.length > 0;
}

export function computeCampaigns(contacts: Contact[], input: CampaignsInput): CampaignsView {
  return {
    loops: input.loops.map((l) => buildLoop(contacts, l, input.dayLabels)),
  };
}
