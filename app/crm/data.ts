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
  loops: number[];
  owner: string | null;
  status: string;
  touches: Touch[];
  notes: Note[];
  followUp: number | null;
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

export const OWNERS: Record<string, Owner> = {
  Tom: { initial: "T", color: "#4457c9" },
  Britton: { initial: "B", color: "#0d8f7a" },
};

export const VIEWER = "Tom";
export const TODAY = new Date(2026, 6, 16);

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function noteFor(ch: string, k: number) {
  if (k > 0) return "";
  const m: Record<string, string> = {
    ad: "Retargeting creative served; landing-page visit logged.",
    email: "Sent intro sequence, awaiting open.",
    linkedin: "Connection request + short opener.",
    call: "Left voicemail, referenced prior touch.",
  };
  return m[ch] || "";
}

function deskNote(status: string) {
  const m: Record<string, string> = {
    Replied: "Asked for a one-pager and pricing — warm. Loop back Thursday.",
    "Meeting booked":
      "Booked 30-min intro. Wants to see the community-blitz angle specifically.",
    Won: "Signed pilot. Hand off to onboarding, keep in Loop 1 for expansion.",
  };
  return m[status] || "";
}

type BaseRow = [
  string,
  string,
  number[],
  string,
  string,
  ContactOpts?,
];

export function buildData(): Contact[] {
  const base: BaseRow[] = [
    ["Marcus Reeve", "Northwind Freight", [1], "Tom", "Replied"],
    ["Dana Okafor", "Cedarline Health", [1], "Britton", "Contacted"],
    ["Priya Nair", "Halcyon Labs", [1, 2], "Tom", "Meeting booked", { mix: true }],
    ["Sokol Berisha", "Vantage Retail", [1], "Britton", "New"],
    ["Elena Duarte", "Brightpath Ed", [2], "Britton", "Contacted"],
    ["Jamal Whitfield", "Orbit Logistics", [1], "Tom", "Won"],
    ["Naomi Sørensen", "Fenwick & Cole", [1, 2], "Britton", "Replied", { mix: true }],
    ["Theo Karamanlis", "Quillix", [1], "Tom", "Dead"],
    ["Grace Lim", "Meridian Foods", [2], "Britton", "Meeting booked"],
    ["Owen Castellano", "Trailhead Gear", [1], "Tom", "Contacted"],
    ["Farida Hassan", "Lumen Analytics", [1, 2], "Tom", "Contacted"],
    ["Bianca Toma", "Riverstone Legal", [1], "Britton", "New"],
    ["Devin Park", "Nimbus Cloud", [1], "Tom", "Replied"],
    ["Aisha Rahman", "Copperfield Mfg", [2], "Britton", "New", { unassigned: true }],
    ["Lars Møller", "Beacon Insurance", [1], "Tom", "Contacted"],
    [" Camille Fontaine", "Solterra Energy", [1, 2], "Britton", "Meeting booked", { mix: true }],
    ["Reuben Adeyemi", "Kestrel Media", [2], "Britton", "Replied"],
    ["Sana Kapoor", "Driftwood Hotels", [1], "Tom", "New"],
    ["Nikolai Petrov", "Anvil Robotics", [1], "Tom", "Won"],
    ["Yara Haddad", "Palmetto Bank", [2], "Britton", "Contacted"],
    ["Colin Mayweather", "Junction Rail", [1], "Tom", "Dead"],
    ["Ines Vidal", "Aster Biotech", [1, 2], "Tom", "Replied"],
    ["Kwame Mensah", "Foundry Works", [2], "Britton", "New", { unassigned: true }],
    ["Hannah Lindqvist", "Verdi Interiors", [1], "Britton", "Contacted"],
    ["Rafael Ortiz", "Slate & Ivory", [1], "Tom", "Meeting booked"],
    ["Mei-Ling Chou", "Polaris Devices", [1, 2], "Britton", "Contacted", { mix: true }],
    ["Gustavo Ferrer", "Harbor Freight Co", [2], "Britton", "Replied"],
    ["Tabitha Cross", "Willowbrook", [1], "Tom", "New"],
    ["Amara Diallo", "Continuum AI", [1], "Tom", "Contacted"],
    ["Sergio Ricci", "Basalt Ventures", [2], "Britton", "Meeting booked"],
  ];
  const rnd = rng(42);
  const cnt: Record<string, number> = {
    New: 1,
    Contacted: 2,
    Replied: 3,
    "Meeting booked": 4,
    Won: 5,
    Dead: 2,
  };
  return base.map((b, i) => {
    const [name, company, loops, owner, status, opts = {}] = b;
    const nc = name.trim();
    const assignee = opts.unassigned ? null : owner;
    const n = cnt[status] || 2;
    const chById: Record<number, string[]> = {
      1: ["ad", "email", "linkedin"],
      2: ["linkedin", "email", "call"],
    };
    const touches: Touch[] = [];
    let day = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const loop = loops[Math.floor(rnd() * loops.length)];
      const pool = chById[loop];
      const ch = pool[Math.floor(rnd() * pool.length)];
      let towner = assignee || owner;
      if (opts.mix && k % 2 === 1) towner = owner === "Tom" ? "Britton" : "Tom";
      if (opts.unassigned) towner = k % 2 === 0 ? "Tom" : "Britton";
      touches.push({ owner: towner, ch, loop, daysAgo: day, note: noteFor(ch, k) });
      day += 2 + Math.floor(rnd() * 6);
    }
    touches.sort((a, b2) => a.daysAgo - b2.daysAgo); // newest first
    const notes: Note[] = [];
    if (status === "Replied" || status === "Meeting booked" || status === "Won") {
      notes.push({
        author: touches[0].owner,
        text: deskNote(status),
        daysAgo: touches[0].daysAgo,
      });
    }
    let followUp: number | null = null;
    if (["New", "Contacted", "Replied"].includes(status) && rnd() > 0.45) {
      followUp = -(1 + Math.floor(rnd() * 4)); // due in N days (negative daysAgo)
    }
    if (status === "Meeting booked") followUp = -(1 + Math.floor(rnd() * 2));
    return {
      id: "c" + i,
      name: nc,
      company,
      loops,
      owner: assignee,
      status,
      touches,
      notes,
      followUp,
      opts,
    };
  });
}

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
