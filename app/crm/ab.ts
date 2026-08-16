// A/B aggregation for the /templates page.
//
// Pure and isomorphic, on the same terms as ./analytics.ts: no React, no server
// imports, and no `Date`. Every relative figure arrives as an integer the loader
// already stamped (`runningDays`), and every absolute label arrives precomputed.
// That is what keeps SSR and client hydration byte-identical.
//
// It also precomputes what the view needs to *draw* — bar widths, colours, pill
// styles, every verdict sentence — so templates-page.tsx stays a plain mapper.
//
// ---------------------------------------------------------------------------
// What the numbers are, and what they are not
// ---------------------------------------------------------------------------
//
// Nothing in this app sends email or tracks opens. `sends`/`opens`/`replies`/
// `meetings` are absolute counters pushed by an external sending tool (or typed
// in by hand); see recordVariantStats in app/lib/crm.server.ts. Rates and the
// verdict below are derived from them on every render and never stored, so a
// corrected push immediately corrects the verdict.
//
// The confidence figure is a two-sided two-proportion z-test on REPLY RATE. Read
// its limits honestly:
//
//   * It is a FIXED-HORIZON test being read continuously. Every page load is a
//     "peek", and stopping when the number looks good inflates the false-positive
//     rate far above the nominal 5%. MIN_SENDS_PER_VARIANT is a crude mitigation,
//     NOT a sequential-testing correction. If this ever drives real money, the
//     right fix is a sequential test (e.g. mSPRT), which is a different module.
//   * "Confidence 97%" is 1 − p for the null hypothesis "the two reply rates are
//     equal". It is NOT the probability that B is better than A.
//   * It assumes each send is an independent Bernoulli trial and that assignment
//     to A or B is unrelated to who was contacted and when. Nothing in this app
//     enforces that — if the sender gave B the warmer list, the difference is
//     confounded and this number is meaningless.
//   * The normal approximation is unreliable when n·p < 5, which is most of what
//     the volume gate exists to catch.
//   * Only reply rate is tested. Open rate is pixel-dependent and meetings are
//     usually far too sparse for the approximation, so both are shown as raw
//     rates with no verdict attached.

import {
  UNTITLED,
  loopLabel,
  templateStatusPill,
  type EmailTemplate,
  type TemplateStatus,
  type TemplateVariant,
} from "./templates";

/**
 * Two-sided confidence at or above which the test is reported as callable. 95%
 * is the conventional α = 0.05.
 *
 * Note this makes the design mockup's "Confidence 94% · Enough volume to call it"
 * self-contradictory: a genuine 94% renders as "not conclusive" here. Lowering the
 * threshold to match the artwork would be tuning the statistics to fit a picture.
 */
const CALL_IT = 95;

/**
 * Minimum sends on the *smaller* variant before any verdict is called, whatever
 * the z-test says. Guards the normal approximation at small n, and blunts the
 * peeking problem described above.
 */
const MIN_SENDS_PER_VARIANT = 100;

/** The honesty note attached to every computed confidence figure, as a tooltip. */
const CONFIDENCE_CAVEAT =
  "Two-sided two-proportion z-test on reply rate. This is the probability that a " +
  "difference this large would not arise by chance if the two variants were " +
  "equally good, not the probability that the leader is better. It assumes A/B " +
  "assignment was unrelated to who was contacted, and it is read continuously " +
  "rather than at a fixed sample size, so treat it as a rough guide.";

/** Percentage for display. Returns 0 (not NaN) on an empty denominator. */
const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * A rate that distinguishes "0%" from "no data". Null denominators render as a
 * hyphen; reporting 0% for a variant nobody has sent yet would be a lie.
 */
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

const rateText = (r: number | null): string => (r === null ? "-" : `${r}%`);

export type MetricCell = { key: string; label: string; value: string };

export type VariantView = {
  id: string;
  slot: string;
  label: string;
  subject: string;
  /** Rendered when `subject` is empty — a draft must be legible, not blank. */
  subjectPlaceholder: string;
  /** The raw stored body, for seeding the inline editor's textarea. */
  body: string;
  /** Body split on blank lines. Each paragraph renders with white-space:pre-wrap. */
  bodyParagraphs: string[];
  bodyPlaceholder: string;
  isDefault: boolean;
  /** Drives the green "Leading" pill. False for every variant until a leader exists. */
  leading: boolean;
  sends: number;
  opens: number;
  replies: number;
  meetings: number;
  openRate: number | null;
  replyRate: number | null;
  meetingRate: number | null;
  metrics: MetricCell[];
  barWidth: string;
  barColor: string;
  promoteLabel: string;
  canPromote: boolean;
  canRemove: boolean;
};

export type VerdictTone = "none" | "single" | "tied" | "thin" | "called";

export type VerdictView = {
  tone: VerdictTone;
  headline: string;
  detail: string;
  /** Long-form limits, for a title= tooltip. Empty when no figure is shown. */
  caveat: string;
  confidencePct: number | null;
  leaderSlot: string | null;
};

export type TemplateCardView = {
  id: string;
  loop: number;
  displayName: string;
  /** "Loop 1 · running 12d" */
  metaLine: string;
  /** "Best: B · 19% reply" or "No sends yet" */
  bestLine: string;
  selected: boolean;
};

export type TemplateDetailView = {
  id: string;
  /** The stored name, for seeding the rename input — may be empty. */
  name: string;
  displayName: string;
  loop: number;
  status: TemplateStatus;
  sendDay: number;
  pill: { label: string; style: string };
  /** "Sent on day 0 of the always-on sequence." */
  sendLine: string;
  verdict: VerdictView;
  variants: VariantView[];
  canAddVariant: boolean;
  totalSends: number;
};

export type TemplatesView = {
  /** "6 templates · 2 A/B tests running" */
  headerSub: string;
  cards: TemplateCardView[];
  detail: TemplateDetailView | null;
  /** No templates at all — a fresh database. */
  isEmpty: boolean;
  /** Templates exist, but none in the active loop filter. */
  filterEmpty: boolean;
  /** Per-loop template counts, for the sidebar's VIEWS rows. */
  counts: { all: number; loop1: number; loop2: number };
};

/** A template is "running an A/B test" only with two variants actually live. */
const isTesting = (t: EmailTemplate): boolean =>
  t.status === "running" && t.variants.length === 2;

function metaLine(t: EmailTemplate): string {
  const loop = loopLabel(t.loop);
  if (t.status === "concluded") return `${loop} · concluded`;
  if (t.status === "running") {
    return t.runningDays === null ? `${loop} · running` : `${loop} · running ${t.runningDays}d`;
  }
  return `${loop} · draft`;
}

function bestLine(t: EmailTemplate): string {
  const sent = t.variants.filter((v) => v.sends > 0);
  if (!sent.length) return "No sends yet";
  let best = sent[0];
  for (const v of sent) {
    if (v.replies / v.sends > best.replies / best.sends) best = v;
  }
  return `Best: ${best.slot} · ${pct(best.replies, best.sends)}% reply`;
}

// Standard normal CDF, Abramowitz & Stegun 26.2.17 (|error| < 7.5e-8). Hardcoded
// rather than pulled in as a dependency: this is the only statistics in the app,
// and eight lines beats a package.
function normalCdf(z: number): number {
  const a = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * a);
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upperTail = (Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? 1 - upperTail : upperTail;
}

/**
 * Two-sided confidence that the two reply rates differ, as a whole percentage.
 * Null when the test cannot be run at all (an empty variant, or both variants at
 * exactly the same extreme, which collapses the pooled standard error to zero).
 */
function replyConfidence(a: TemplateVariant, b: TemplateVariant): number | null {
  if (a.sends === 0 || b.sends === 0) return null;
  const pPool = (a.replies + b.replies) / (a.sends + b.sends);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.sends + 1 / b.sends));
  if (!(se > 0)) return null;
  const z = (a.replies / a.sends - b.replies / b.sends) / se;
  return Math.round((2 * normalCdf(Math.abs(z)) - 1) * 100);
}

function buildVerdict(variants: TemplateVariant[]): VerdictView {
  const base = { caveat: "", confidencePct: null, leaderSlot: null };

  if (variants.length < 2) {
    return {
      ...base,
      tone: "single",
      headline: "Only one variant.",
      detail: "Add a variant B to start an A/B test.",
    };
  }

  const [a, b] = variants;
  const totalSends = a.sends + b.sends;

  if (totalSends === 0) {
    return {
      ...base,
      tone: "none",
      headline: "No sends yet.",
      detail: "Record numbers from your sending tool to see a verdict.",
    };
  }

  const rateA = rate(a.replies, a.sends);
  const rateB = rate(b.replies, b.sends);
  if (rateA === null || rateB === null) {
    const missing = rateA === null ? a.slot : b.slot;
    return {
      ...base,
      tone: "thin",
      headline: `Nothing sent on variant ${missing} yet.`,
      detail: `${totalSends} sends so far, all on one variant, so there is no comparison to make.`,
    };
  }

  if (rateA === rateB) {
    return {
      ...base,
      tone: "tied",
      headline: `Variants ${a.slot} and ${b.slot} are level on reply rate across ${totalSends} sends.`,
      detail: "No difference to act on yet.",
    };
  }

  const leader = rateA > rateB ? a : b;
  // The gap is computed from the ROUNDED rates, not the raw floats, so this
  // sentence always agrees with the metrics row above it. (10.4% and 18.6% render
  // as 10 and 19 — a raw difference of 8 would visibly contradict them.)
  const gap = Math.abs(rateA - rateB);
  const headline =
    `Variant ${leader.slot} is ahead by ${gap} point${gap === 1 ? "" : "s"} ` +
    `on reply rate across ${totalSends} sends.`;

  const confidencePct = replyConfidence(a, b);
  if (confidencePct === null) {
    return {
      ...base,
      tone: "thin",
      headline,
      detail: "Not enough signal to compute a confidence figure.",
      leaderSlot: leader.slot,
    };
  }

  const smallest = Math.min(a.sends, b.sends);
  if (smallest < MIN_SENDS_PER_VARIANT) {
    return {
      tone: "thin",
      headline,
      detail:
        `Confidence ${confidencePct}% · Only ${smallest} sends on one variant, ` +
        `too early to call.`,
      caveat: CONFIDENCE_CAVEAT,
      confidencePct,
      leaderSlot: leader.slot,
    };
  }
  if (confidencePct < CALL_IT) {
    return {
      tone: "thin",
      headline,
      detail: `Confidence ${confidencePct}% · Not conclusive. Keep both running.`,
      caveat: CONFIDENCE_CAVEAT,
      confidencePct,
      leaderSlot: leader.slot,
    };
  }
  return {
    tone: "called",
    headline,
    detail: `Confidence ${confidencePct}% · Enough volume to call it.`,
    caveat: CONFIDENCE_CAVEAT,
    confidencePct,
    leaderSlot: leader.slot,
  };
}

/** Split a body into paragraphs on blank lines. Single newlines stay inside one. */
function paragraphs(body: string): string[] {
  return body
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0);
}

function buildVariant(
  v: TemplateVariant,
  leaderSlot: string | null,
  leaderRate: number | null,
  canRemove: boolean,
): VariantView {
  const openRate = rate(v.opens, v.sends);
  const replyRate = rate(v.replies, v.sends);
  const meetingRate = rate(v.meetings, v.sends);
  const leading = leaderSlot !== null && v.slot === leaderSlot;

  // The leader's bar is full; the other is drawn in proportion to it. Clamped to
  // [4, 100] so a pushed rate above the leader's (or above 100%) can't overflow
  // the track — but the printed percentage is never clamped, because a 140% reply
  // rate is a real signal that the sender is double-counting.
  let barWidth = "0%";
  if (replyRate !== null) {
    if (leading || leaderRate === null || leaderRate <= 0) {
      barWidth = replyRate > 0 ? "100%" : "0%";
    } else {
      barWidth = `${Math.min(100, Math.max(4, Math.round((replyRate / leaderRate) * 100)))}%`;
    }
  }

  return {
    id: v.id,
    slot: v.slot,
    label: `Variant ${v.slot}`,
    subject: v.subject,
    subjectPlaceholder: "No subject yet",
    body: v.body,
    bodyParagraphs: paragraphs(v.body),
    bodyPlaceholder: "No body yet",
    isDefault: v.isDefault,
    leading,
    sends: v.sends,
    opens: v.opens,
    replies: v.replies,
    meetings: v.meetings,
    openRate,
    replyRate,
    meetingRate,
    metrics: [
      { key: "sends", label: "Sent", value: String(v.sends) },
      { key: "opens", label: "Open", value: rateText(openRate) },
      { key: "replies", label: "Reply", value: rateText(replyRate) },
      { key: "meetings", label: "Mtgs", value: String(v.meetings) },
    ],
    barWidth,
    barColor: leading ? "#146c3a" : "#d8d8d3",
    promoteLabel: v.isDefault ? "Default variant" : `Promote ${v.slot} to default`,
    canPromote: !v.isDefault,
    canRemove,
  };
}

function buildDetail(t: EmailTemplate, verdict: VerdictView): TemplateDetailView {
  const leaderRate = (() => {
    if (!verdict.leaderSlot) return null;
    const leader = t.variants.find((v) => v.slot === verdict.leaderSlot);
    return leader ? rate(leader.replies, leader.sends) : null;
  })();

  return {
    id: t.id,
    name: t.name,
    displayName: t.name || UNTITLED,
    loop: t.loop,
    status: t.status,
    sendDay: t.sendDay,
    pill: templateStatusPill(t.status, t.runningDays),
    // Composed from the loop rather than hardcoding the mockup's Loop 1 wording,
    // which would misdescribe a Loop 2 template.
    sendLine:
      `Sent on day ${t.sendDay} of the ` +
      `${t.loop === 2 ? "event/community blitz" : "always-on sequence"}.`,
    verdict,
    variants: t.variants.map((v) =>
      buildVariant(v, verdict.leaderSlot, leaderRate, t.variants.length > 1 && v.slot !== "A"),
    ),
    canAddVariant: t.variants.length === 1,
    totalSends: t.variants.reduce((sum, v) => sum + v.sends, 0),
  };
}

/**
 * Everything /templates renders, from the loader's template list plus the two
 * pieces of UI state that affect it.
 *
 * Selection is resolved *here*, not in the component: a `selectedId` that is
 * absent from the filtered list falls back to the first card. That is what lets
 * the page hold a stale id after a delete or a filter change without needing the
 * reconciling useEffect that sales-loop-crm.tsx carries for exactly this case.
 */
export function computeTemplatesView(
  templates: EmailTemplate[],
  selectedId: string | null,
  loopFilter: number | null,
): TemplatesView {
  // Counts are over the UNFILTERED list, the same rule the sidebar's contact
  // counts follow: the rail reports what each filter would yield.
  const counts = {
    all: templates.length,
    loop1: templates.filter((t) => t.loop === 1).length,
    loop2: templates.filter((t) => t.loop === 2).length,
  };

  const testing = templates.filter(isTesting).length;
  const headerSub =
    `${templates.length} template${templates.length === 1 ? "" : "s"}` +
    (testing ? ` · ${testing} A/B test${testing === 1 ? "" : "s"} running` : "");

  const filtered =
    loopFilter === null ? templates : templates.filter((t) => t.loop === loopFilter);

  const selected =
    filtered.find((t) => t.id === selectedId) ?? (filtered.length ? filtered[0] : null);

  const cards: TemplateCardView[] = filtered.map((t) => ({
    id: t.id,
    loop: t.loop,
    displayName: t.name || UNTITLED,
    metaLine: metaLine(t),
    bestLine: bestLine(t),
    selected: selected !== null && t.id === selected.id,
  }));

  return {
    headerSub,
    cards,
    detail: selected ? buildDetail(selected, buildVerdict(selected.variants)) : null,
    isEmpty: templates.length === 0,
    filterEmpty: templates.length > 0 && filtered.length === 0,
    counts,
  };
}
