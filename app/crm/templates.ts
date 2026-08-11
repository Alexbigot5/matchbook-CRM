// The email-template model: types, closed sets, and the status pill.
//
// Deliberately its own module rather than an addition to ./data.ts — that file is
// the *contacts* model, and app/lib/validate.ts already imports it broadly. This
// one is the contract between listTemplates() in app/lib/crm.server.ts and the
// /templates UI, exactly as `Contact` is for the contacts page.
//
// Pure and isomorphic: no React, no server imports, and — critically — no `Date`.
// Every relative figure the page renders (`runningDays`) and every absolute label
// (`startedLabel`) is computed in the loader against its single `now`, which is
// what keeps SSR and client hydration byte-identical.

import { STATUSES } from "./data";

export type TemplateStatus = "draft" | "running" | "concluded";
export type VariantSlot = "A" | "B";

/**
 * The closed set of statuses. Whitelisted here (and consumed by
 * app/lib/validate.ts) rather than as a SQL CHECK constraint, because SQLite
 * cannot drop a CHECK without rebuilding the table.
 */
export const TEMPLATE_STATUSES = ["draft", "running", "concluded"] as const;

/** A/B only. A third variant would need a migration for the unique index. */
export const VARIANT_SLOTS = ["A", "B"] as const;

/** Name a "+ New" template is born with; also the display fallback for a blank. */
export const UNTITLED = "Untitled template";

export type TemplateVariant = {
  id: string;
  /** "A" | "B" — kept as a plain string, the same way `Contact.status` is. */
  slot: string;
  subject: string;
  body: string;
  isDefault: boolean;
  sends: number;
  opens: number;
  replies: number;
  meetings: number;
};

export type EmailTemplate = {
  id: string;
  name: string;
  loop: number;
  status: TemplateStatus;
  sendDay: number;
  /**
   * Whole days since the template started running; null while it is a draft.
   *
   * Note what is NOT here: the raw `started_at` ISO string. Exposing it would
   * invite `dayDiff(started_at, Date.now())` in the render path, which diverges
   * between the server render and hydration. Removing the temptation beats
   * commenting about it.
   */
  runningDays: number | null;
  /** "Jul 20"-style absolute label, or null. Precomputed in the loader. */
  startedLabel: string | null;
  concludedLabel: string | null;
  /** Slot-ascending, so `variants[0]` is always A. One or two entries. */
  variants: TemplateVariant[];
};

// Pill colours are lifted from STATUSES in ./data.ts rather than invented, so the
// page can't drift out of the app's closed palette: green = "Meeting booked"
// (something is happening), grey = "New" (nothing yet).
const GREEN = STATUSES.find((s) => s.id === "Meeting booked")!;
const GREY = STATUSES.find((s) => s.id === "New")!;

const PILL =
  "display:inline-flex; align-items:center; padding:2px 8px; border-radius:6px; font-size:11.5px; font-weight:500;";

/**
 * The status pill next to a template's name. Same `{ label, style }` shape as
 * `statusPill`/`loopBadge` in ./data.ts, so the page renders it the same way.
 *
 * `runningDays` is folded into the label ("Running · day 12") because the mockup
 * shows the age there and the caller has already had it computed by the loader.
 */
export function templateStatusPill(
  status: TemplateStatus,
  runningDays: number | null,
): { label: string; style: string } {
  if (status === "running") {
    // A template can be 'running' with started_at somehow missing (a hand-edited
    // row); fall back to the bare word rather than printing "day null".
    const label = runningDays === null ? "Running" : `Running · day ${runningDays}`;
    return { label, style: PILL + `background:${GREEN.bg}; color:${GREEN.fg};` };
  }
  if (status === "concluded") {
    return { label: "Concluded", style: PILL + "background:#f0f0ec; color:#75756f;" };
  }
  return { label: "Draft", style: PILL + `background:${GREY.bg}; color:${GREY.fg};` };
}

/** Human label for a loop, matching the sidebar footer's wording. */
export function loopLabel(loop: number): string {
  return loop === 2 ? "Loop 2" : "Loop 1";
}
