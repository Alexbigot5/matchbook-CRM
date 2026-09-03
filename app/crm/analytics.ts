// Analytics aggregation for the /analytics page.
//
// Pure and isomorphic on purpose: no React, no server imports, and — critically —
// no `Date`. Every absolute date this page shows arrives precomputed from the
// loader (see buildAnalyticsLabels in app/lib/crm.server.ts), and every relative
// figure is derived from the `daysAgo` integers listContacts already stamped. That
// is what keeps SSR and client hydration byte-identical.
//
// It also precomputes what the view needs to *draw* — colours, bar widths, icon
// markup — so analytics-page.tsx stays a plain mapper. Same idiom as
// sales-loop-crm.tsx, which builds its row descriptors before the JSX.
//
// A note on the two derived metrics: nothing records a reply or a booking as an
// event, so "replied" and "meetings" are read off the pipeline stage a contact has
// reached. That means they reflect a contact's CURRENT status, not its history —
// someone who replied and was later marked Dead stops counting as replied.

import { CH, type Contact, ownerAvatar, STATUSES } from "./data";

/** Statuses that imply the contact replied at some point. */
const REPLIED = new Set(["Replied", "Meeting booked", "Won"]);
/** Statuses that imply a meeting was booked. */
const MEETING = new Set(["Meeting booked", "Won"]);

/** Percentage for display. Returns 0 (not NaN) on an empty denominator. */
const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * A rate that distinguishes "0%" from "no data". Null denominators render as an
 * em dash — reporting 0% for a channel nobody has used yet would be a lie.
 */
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

/** Bar width, clamped so a single contact still paints a visible sliver. */
const barWidth = (count: number, total: number): string =>
  count > 0 ? `${Math.max(pct(count, total), 1.5)}%` : "0%";

export type AnalyticsLabels = {
  asOf: string;
  dayLabels: string[];
  /** The same axis as `YYYY-MM-DD` UTC dates. Used only by ./campaigns.ts. */
  dayKeys: string[];
};

export type KpiTile = { key: string; label: string; value: string; sub: string };
export type StageRow = { id: string; count: number; pct: number; dot: string; barWidth: string };
export type LoopStats = {
  loop: number;
  contacts: number;
  touched: number;
  touchedRate: number | null;
  meetings: number;
  won: number;
};
export type ChannelRow = {
  key: string;
  label: string;
  bg: string;
  fg: string;
  icon: string;
  contacts: number;
  touches: number;
  replies: number;
  meetings: number;
  replyRate: number | null;
  meetingRate: number | null;
};
export type SourceRow = {
  source: string;
  contacts: number;
  touched: number;
  replied: number;
  meetings: number;
  meetingRate: number | null;
};
export type DaySegment = { key: string; color: string; height: string };
export type DayColumn = { label: string; total: number; segments: DaySegment[] };
export type ActivityChart = {
  columns: DayColumn[];
  max: number;
  total: number;
  legend: { key: string; label: string; color: string; count: number }[];
  startLabel: string;
  endLabel: string;
};
export type ReasonRow = { key: string; count: number; pct: number; barWidth: string; color: string };
export type OwnerRow = {
  key: string;
  label: string;
  initial: string;
  color: string;
  hasAvatar: boolean;
  contacts: number;
  meetings: number;
  touchpoints: number;
};

export type Analytics = {
  asOf: string;
  total: number;
  kpis: KpiTile[];
  stages: StageRow[];
  loops: LoopStats[];
  channels: ChannelRow[];
  sources: SourceRow[];
  chart: ActivityChart;
  deadTotal: number;
  reasons: ReasonRow[];
  owners: OwnerRow[];
};

/** Muted, in-palette hues for the dead-reason bars, cycled by rank. */
const REASON_COLORS = ["#9a5b5b", "#b0705a", "#a3855c", "#8a7f9a", "#7f8f9a", "#a3a39d"];

const UNSPECIFIED = "Unspecified";

function buildStages(contacts: Contact[]): StageRow[] {
  const total = contacts.length;
  return STATUSES.map((s) => {
    const count = contacts.filter((c) => c.status === s.id).length;
    return {
      id: s.id,
      count,
      pct: pct(count, total),
      dot: s.dot,
      barWidth: barWidth(count, total),
    };
  });
}

function buildLoop(contacts: Contact[], loop: number): LoopStats {
  const inLoop = contacts.filter((c) => c.loops.includes(loop));
  const touched = inLoop.filter((c) => c.touches.length > 0).length;
  return {
    loop,
    contacts: inLoop.length,
    touched,
    touchedRate: rate(touched, inLoop.length),
    meetings: inLoop.filter((c) => MEETING.has(c.status)).length,
    won: inLoop.filter((c) => c.status === "Won").length,
  };
}

/**
 * Per-channel effectiveness. A contact reached on three channels counts once in
 * each — there is no way to attribute a reply to the specific channel that earned
 * it, so every channel that touched them gets the credit. That is why the meeting
 * numbers here can exceed the headline meeting count, and why the rates are
 * captioned "per contact reached on that channel".
 */
function buildChannels(contacts: Contact[]): ChannelRow[] {
  const keys = Object.keys(CH);
  const acc = new Map(
    keys.map((k) => [k, { contacts: 0, touches: 0, replies: 0, meetings: 0 }]),
  );

  for (const c of contacts) {
    const reached = new Set<string>();
    for (const t of c.touches) {
      const bucket = acc.get(t.ch);
      // A touch type outside CH can only come from a hand-edited row; skip it
      // rather than inventing a channel for it.
      if (!bucket) continue;
      bucket.touches++;
      reached.add(t.ch);
    }
    const replied = REPLIED.has(c.status);
    const meeting = MEETING.has(c.status);
    for (const ch of reached) {
      const bucket = acc.get(ch)!;
      bucket.contacts++;
      if (replied) bucket.replies++;
      if (meeting) bucket.meetings++;
    }
  }

  // Every channel is emitted even at zero, so the table doesn't reflow as filters
  // change and an unused channel reads as "nothing logged" rather than vanishing.
  return keys.map((k) => {
    const a = acc.get(k)!;
    return {
      key: k,
      label: CH[k].label,
      bg: CH[k].bg,
      fg: CH[k].fg,
      icon: CH[k].icon,
      contacts: a.contacts,
      touches: a.touches,
      replies: a.replies,
      meetings: a.meetings,
      replyRate: rate(a.replies, a.contacts),
      meetingRate: rate(a.meetings, a.contacts),
    };
  });
}

/** Loop 2 performance grouped by the community/event the contact came from. */
function buildSources(contacts: Contact[]): SourceRow[] {
  const acc = new Map<string, SourceRow>();
  for (const c of contacts) {
    if (!c.loops.includes(2)) continue;
    const source = (c.source || "").trim();
    if (!source) continue;
    const row =
      acc.get(source) ??
      { source, contacts: 0, touched: 0, replied: 0, meetings: 0, meetingRate: null };
    row.contacts++;
    if (c.touches.length > 0) row.touched++;
    if (REPLIED.has(c.status)) row.replied++;
    if (MEETING.has(c.status)) row.meetings++;
    acc.set(source, row);
  }
  return [...acc.values()]
    .map((r) => ({ ...r, meetingRate: rate(r.meetings, r.contacts) }))
    // Explicit name tiebreak: an unstable order between server and client render
    // would be a hydration mismatch.
    .sort((a, b) => b.contacts - a.contacts || a.source.localeCompare(b.source));
}

/**
 * Stacked daily touchpoint volume over the label window.
 *
 * `dayLabels[i]` is (len - 1 - i) days ago, the exact inverse of the `daysAgo`
 * listContacts stamps on each touch — both bucket on UTC midnight. Touches older
 * than the window (or dated in the future by a clock skew) fall outside and are
 * dropped rather than clamped into an edge column.
 */
function buildChart(contacts: Contact[], dayLabels: string[]): ActivityChart {
  const keys = Object.keys(CH);
  const span = dayLabels.length;
  const buckets = dayLabels.map(() => new Map<string, number>());
  const legendCounts = new Map<string, number>();
  let total = 0;

  for (const c of contacts) {
    for (const t of c.touches) {
      if (t.daysAgo < 0 || t.daysAgo >= span) continue;
      if (!Object.hasOwn(CH, t.ch)) continue;
      const bucket = buckets[span - 1 - t.daysAgo];
      bucket.set(t.ch, (bucket.get(t.ch) ?? 0) + 1);
      legendCounts.set(t.ch, (legendCounts.get(t.ch) ?? 0) + 1);
      total++;
    }
  }

  const totals = buckets.map((b) => [...b.values()].reduce((s, n) => s + n, 0));
  // Floor of 1 keeps the height division safe on an empty window.
  const max = Math.max(1, ...totals);

  const columns: DayColumn[] = dayLabels.map((label, i) => ({
    label,
    total: totals[i],
    segments: keys
      .filter((k) => (buckets[i].get(k) ?? 0) > 0)
      .map((k) => ({
        key: k,
        color: CH[k].fg,
        height: `${((buckets[i].get(k) ?? 0) / max) * 100}%`,
      })),
  }));

  return {
    columns,
    max,
    total,
    // Only channels actually used in the window — a legend full of zeroes
    // suggests the chart is broken rather than quiet.
    legend: keys
      .filter((k) => (legendCounts.get(k) ?? 0) > 0)
      .map((k) => ({ key: k, label: CH[k].label, color: CH[k].fg, count: legendCounts.get(k)! })),
    startLabel: dayLabels[0] ?? "",
    endLabel: dayLabels[dayLabels.length - 1] ?? "",
  };
}

function buildReasons(contacts: Contact[]): { deadTotal: number; reasons: ReasonRow[] } {
  const dead = contacts.filter((c) => c.status === "Dead");
  const acc = new Map<string, number>();
  for (const c of dead) {
    // Null covers both contacts marked Dead before the column existed and people
    // who skipped the prompt. Reported honestly rather than guessed at.
    const key = (c.deadReason || "").trim() || UNSPECIFIED;
    acc.set(key, (acc.get(key) ?? 0) + 1);
  }
  const reasons = [...acc.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count], i) => ({
      key,
      count,
      pct: pct(count, dead.length),
      barWidth: barWidth(count, dead.length),
      color: REASON_COLORS[i % REASON_COLORS.length],
    }));
  return { deadTotal: dead.length, reasons };
}

function buildOwners(contacts: Contact[]): OwnerRow[] {
  const acc = new Map<string, { contacts: number; meetings: number; touchpoints: number }>();
  for (const c of contacts) {
    const key = c.owner || "";
    const row = acc.get(key) ?? { contacts: 0, meetings: 0, touchpoints: 0 };
    row.contacts++;
    row.touchpoints += c.touches.length;
    if (MEETING.has(c.status)) row.meetings++;
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
        ...v,
      };
    })
    // Unassigned last regardless of size — it's a to-do, not a performer.
    .sort(
      (a, b) =>
        Number(b.hasAvatar) - Number(a.hasAvatar) ||
        b.contacts - a.contacts ||
        a.label.localeCompare(b.label),
    );
}

export function computeAnalytics(contacts: Contact[], labels: AnalyticsLabels): Analytics {
  const total = contacts.length;
  // Loop 1 and Loop 2 overlap — a Loop 2 contact resumed into Loop 1 is in both,
  // so these deliberately do not sum to `total`.
  const loop1 = contacts.filter((c) => c.loops.includes(1)).length;
  const loop2 = contacts.filter((c) => c.loops.includes(2)).length;
  const touched = contacts.filter((c) => c.touches.length > 0).length;
  const replied = contacts.filter((c) => REPLIED.has(c.status)).length;
  const meetings = contacts.filter((c) => MEETING.has(c.status)).length;
  const won = contacts.filter((c) => c.status === "Won").length;

  const kpis: KpiTile[] = [
    {
      key: "contacts",
      label: "Contacts",
      value: String(total),
      sub: `${loop1} Loop 1 · ${loop2} Loop 2`,
    },
    {
      key: "touched",
      label: "Touched",
      value: total ? `${pct(touched, total)}%` : "-",
      sub: `${touched} of ${total} contacted`,
    },
    {
      key: "reply",
      label: "Reply rate",
      value: touched ? `${pct(replied, touched)}%` : "-",
      sub: `${replied} replied of ${touched} touched`,
    },
    {
      key: "meetings",
      label: "Meetings",
      value: String(meetings),
      sub: total ? `${pct(meetings, total)}% of all contacts` : "no contacts yet",
    },
    {
      key: "won",
      label: "Won",
      value: String(won),
      sub: meetings ? `${pct(won, meetings)}% of meetings closed` : "no meetings yet",
    },
  ];

  const { deadTotal, reasons } = buildReasons(contacts);

  return {
    asOf: labels.asOf,
    total,
    kpis,
    stages: buildStages(contacts),
    loops: [buildLoop(contacts, 1), buildLoop(contacts, 2)],
    channels: buildChannels(contacts),
    sources: buildSources(contacts),
    chart: buildChart(contacts, labels.dayLabels),
    deadTotal,
    reasons,
    owners: buildOwners(contacts),
  };
}
