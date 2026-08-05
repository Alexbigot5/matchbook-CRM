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
  // When a Loop 2 contact was resumed into Loop 1 outbound: raw ISO timestamp
  // plus a precomputed "Jul 20"-style label (null when never resumed).
  resumedToLoop1At?: string | null;
  resumedLabel?: string | null;
  opts: ContactOpts;
};

export type Channel = { label: string; bg: string; fg: string; icon: string };
export type StatusMeta = { id: string; dot: string; bg: string; fg: string };
export type Owner = { initial: string; color: string };

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

export function buildNameIndex(contacts: Contact[]): NameIndex {
  const idx: NameIndex = new Map();
  for (const c of contacts) {
    const key = normalizeName(c.name);
    if (!key) continue;
    const list = idx.get(key) ?? [];
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
