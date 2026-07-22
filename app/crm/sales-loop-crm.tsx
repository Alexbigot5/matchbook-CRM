import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  ago,
  buildNameIndex,
  CH,
  conflictOwners,
  type Contact,
  fmtDate,
  hasNameConflict,
  loopBadge,
  needsAttention,
  NO_TOUCH_ICON,
  OWNERS,
  statusMeta,
  statusPill,
  STATUSES,
  VIEWER,
} from "./data";
import {
  Box,
  css,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconPlus,
  IconSearch,
  IconUpload,
  IconWarn,
} from "./ui";

type FormState = {
  name: string;
  company: string;
  email: string;
  phone: string;
  linkedin: string;
  loops: number[];
  owner: string;
  status: string;
  source: string;
};

type State = {
  view: string;
  owner: string;
  sourceFilter: string;
  stage: string;
  query: string;
  selectedIds: string[];
  selectedId: string | null;
  menuId: string | null;
  detailMenu: boolean;
  noteDraft: string;
  modal: string | null;
  form: FormState;
  csvText: string;
  csvError: string;
  csvDragging: boolean;
  csvFileName: string;
};

type ActionResult = { ok: true } | { ok: false; error: string };

const blankForm = (loops?: number[]): FormState => ({
  name: "",
  company: "",
  email: "",
  phone: "",
  linkedin: "",
  loops: loops || [1],
  owner: "Tom",
  status: "New",
  source: "",
});

const GLOBAL_CSS = `
  .slcrm * { box-sizing: border-box; }
  .slcrm { font-family: 'Geist', system-ui, sans-serif; color: #1a1a1a; -webkit-font-smoothing: antialiased; }
  .slcrm ::-webkit-scrollbar { width: 10px; height: 10px; }
  .slcrm ::-webkit-scrollbar-thumb { background: #e2e2df; border-radius: 6px; border: 3px solid #fff; }
  .slcrm ::-webkit-scrollbar-thumb:hover { background: #d0d0cd; }
  @keyframes slcrm-slideIn { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes slcrm-fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slcrm-slideDown { from { transform: translateY(-12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;

const MONO = "font-family:'Geist Mono',monospace;";

// Normalize a stored LinkedIn value (URL or bare handle) into an absolute href.
// Empty when there's nothing to link to.
const linkedinUrl = (raw: string | null | undefined) => {
  const v = (raw || "").trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
};

// Small amber pill marking a Loop 2 contact's community/event of origin.
function SourceTag({ label }: { label: string }) {
  return (
    <span
      title={"From " + label}
      style={css(
        "display:inline-flex; align-items:center; gap:4px; max-width:150px; padding:1px 7px 1px 6px; border-radius:6px; font-size:11px; font-weight:500; background:#faf3e6; color:#9a6f34; border:1px solid #f0e4cf; white-space:nowrap; overflow:hidden; flex:0 0 auto;",
      )}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={css("flex:0 0 auto;")}>
        <path
          d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M12 6v12" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.5 2.5" />
      </svg>
      <span style={css("overflow:hidden; text-overflow:ellipsis;")}>{label}</span>
    </span>
  );
}

// Small clickable LinkedIn glyph that opens the profile in a new tab. Stops
// click propagation so it doesn't also open the contact detail panel.
function LinkedinButton({ href, stopProp }: { href: string; stopProp: (e: any) => void }) {
  return (
    <Box
      as="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopProp}
      title="Open LinkedIn profile"
      style={css(
        "flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:5px; color:" +
          CH.linkedin.fg +
          "; background:" +
          CH.linkedin.bg +
          "; text-decoration:none;",
      )}
      hover={css("filter:brightness(0.95);")}
    >
      <span dangerouslySetInnerHTML={{ __html: CH.linkedin.icon }} style={css("display:flex;")} />
    </Box>
  );
}

// Custom checkbox for row/bulk selection. `indeterminate` renders the "some
// selected" dash used by the header select-all.
function Checkbox({
  checked,
  indeterminate,
  onClick,
  title,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onClick: (e: any) => void;
  title?: string;
}) {
  const on = checked || indeterminate;
  return (
    <Box
      as="button"
      onClick={onClick}
      title={title}
      style={css(
        `flex:0 0 auto; width:17px; height:17px; border-radius:5px; display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; border:1.5px solid ${on ? "#1a1a1a" : "#cfcfc9"}; background:${on ? "#1a1a1a" : "#fff"}; color:#fff;`,
      )}
      hover={css(on ? "filter:brightness(1.15);" : "border-color:#a9a9a3;")}
    >
      {indeterminate ? (
        <span style={css("width:8px; height:2px; border-radius:1px; background:#fff;")} />
      ) : checked ? (
        <IconCheck style={css("width:11px; height:11px;")} />
      ) : null}
    </Box>
  );
}

export function SalesLoopCRM({ contacts }: { contacts: Contact[] }) {
  const fetcher = useFetcher();
  const [state, setState] = useState<State>(() => ({
    view: "all",
    owner: "all",
    sourceFilter: "all",
    stage: "all",
    query: "",
    selectedIds: [],
    selectedId: null,
    menuId: null,
    detailMenu: false,
    noteDraft: "",
    modal: null,
    form: blankForm([1]),
    csvText: "",
    csvError: "",
    csvDragging: false,
    csvFileName: "",
  }));

  const patch = (u: Partial<State> | ((s: State) => Partial<State>)) =>
    setState((s) => ({ ...s, ...(typeof u === "function" ? u(s) : u) }));

  const S = state;

  // Persistence goes through the route action; React Router revalidates the
  // loader after each write, so `contacts` (a prop) is always fresh. This effect
  // only reconciles modal/error UI once a submission settles.
  const submit = (fields: Record<string, string>) =>
    fetcher.submit(fields, { method: "post" });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const result = fetcher.data as ActionResult;
    if (result.ok) {
      patch((s) => (s.modal ? { modal: null, csvText: "", csvError: "" } : {}));
    } else {
      patch({ csvError: result.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // ---- handlers ----
  // The source filter only applies inside Loop 2, so reset it when leaving.
  const setView = (v: string) =>
    patch(v === "loop2" ? { view: v, menuId: null } : { view: v, menuId: null, sourceFilter: "all" });
  const setOwner = (o: string) => patch({ owner: o, menuId: null });
  const setSourceFilter = (s: string) => patch({ sourceFilter: s, menuId: null });
  const setStage = (s: string) => patch({ stage: s, menuId: null });
  const onSearch = (e: any) => patch({ query: e.target.value });
  const toggleSelect = (id: string, e?: any) => {
    if (e) e.stopPropagation();
    patch((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    }));
  };
  const clearSelection = () => patch({ selectedIds: [] });
  const open = (id: string) =>
    patch({ selectedId: id, noteDraft: "", menuId: null, detailMenu: false });
  const close = () => patch({ selectedId: null, detailMenu: false });
  const toggleMenu = (id: string, e?: any) => {
    if (e) e.stopPropagation();
    patch((s) => ({ menuId: s.menuId === id ? null : id }));
  };
  const toggleDetailMenu = () => patch((s) => ({ detailMenu: !s.detailMenu }));
  const setStatus = (id: string, status: string, e?: any) => {
    if (e) e.stopPropagation();
    patch({ menuId: null, detailMenu: false });
    submit({ intent: "setStatus", id, status });
  };
  const onNoteInput = (e: any) => patch({ noteDraft: e.target.value });
  const addNote = () => {
    const txt = (S.noteDraft || "").trim();
    if (!txt || !S.selectedId) return;
    patch({ noteDraft: "" });
    submit({ intent: "addNote", id: S.selectedId, text: txt });
  };
  const logMeeting = () => {
    const txt = (S.noteDraft || "").trim();
    if (!txt || !S.selectedId) return;
    patch({ noteDraft: "" });
    submit({ intent: "logMeeting", id: S.selectedId, text: txt });
  };
  const onNoteKey = (e: any) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      addNote();
    }
  };
  const snoozeFollow = () => {
    if (!S.selectedId) return;
    submit({ intent: "snooze", id: S.selectedId });
  };
  const clearFollow = () => {
    if (!S.selectedId) return;
    submit({ intent: "clearFollow", id: S.selectedId });
  };
  const resumeLoop1 = () => {
    if (!S.selectedId) return;
    submit({ intent: "resumeLoop1", id: S.selectedId });
  };

  const defaultLoops = () => (S.view === "loop2" ? [2] : [1]);
  const openAdd = () => patch({ modal: "add", form: blankForm(defaultLoops()) });
  const openCsv = () =>
    patch({ modal: "csv", csvText: "", csvError: "", csvDragging: false, csvFileName: "" });
  const closeModal = () =>
    patch({ modal: null, csvError: "", csvDragging: false, csvFileName: "" });

  // Read a dropped/selected .csv into the paste textarea, then the existing
  // importCsv parser handles it. FileReader only runs in these browser event
  // handlers (never during SSR), so there's no hydration concern.
  const readCsvFile = (file: File | null | undefined) => {
    if (!file) return;
    const isCsv =
      /\.csv$/i.test(file.name) ||
      file.type === "text/csv" ||
      file.type === "application/vnd.ms-excel" ||
      file.type === "text/plain";
    if (!isCsv) {
      patch({ csvError: "That doesn’t look like a .csv file.", csvDragging: false });
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      patch({
        csvText: typeof reader.result === "string" ? reader.result : "",
        csvError: "",
        csvDragging: false,
        csvFileName: file.name,
      });
    reader.onerror = () =>
      patch({ csvError: "Couldn’t read that file.", csvDragging: false });
    reader.readAsText(file);
  };
  const onCsvDrop = (e: any) => {
    e.preventDefault();
    readCsvFile(e.dataTransfer?.files?.[0]);
  };
  const onCsvDragOver = (e: any) => {
    e.preventDefault();
    if (!S.csvDragging) patch({ csvDragging: true });
  };
  const onCsvDragLeave = (e: any) => {
    e.preventDefault();
    patch({ csvDragging: false });
  };
  const onCsvFileInput = (e: any) => {
    readCsvFile(e.target.files?.[0]);
    e.target.value = ""; // allow re-selecting the same file
  };
  const setForm = (p: Partial<FormState>) =>
    patch((s) => ({ form: { ...s.form, ...p } }));
  const toggleFormLoop = (n: number) =>
    patch((s) => {
      const has = s.form.loops.includes(n);
      let loops = has ? s.form.loops.filter((x) => x !== n) : [...s.form.loops, n];
      if (!loops.length) loops = [n];
      return { form: { ...s.form, loops: loops.sort() } };
    });
  const submitAdd = () => {
    const f = S.form;
    if (!f.name.trim()) return;
    submit({
      intent: "addContact",
      name: f.name.trim(),
      company: (f.company || "").trim(),
      email: (f.email || "").trim(),
      phone: (f.phone || "").trim(),
      linkedin: (f.linkedin || "").trim(),
      loops: JSON.stringify(f.loops.length ? f.loops : [1]),
      owner: f.owner === "Unassigned" ? "" : f.owner,
      status: f.status || "New",
      source: f.loops.includes(2) ? f.source.trim() : "",
    });
  };
  const importCsv = () => {
    const raw = (S.csvText || "").trim();
    if (!raw) {
      patch({ csvError: "Drop a .csv file first." });
      return;
    }
    const rows = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parseLoops = (v: string) => {
      const s = (v || "").toLowerCase();
      const out: number[] = [];
      if (/\b1\b|loop\s*1|general|outbound/.test(s)) out.push(1);
      if (/\b2\b|loop\s*2|event|blitz|community/.test(s)) out.push(2);
      return out.length ? out : [S.view === "loop2" ? 2 : 1];
    };
    const parseOwner = (v: string) => {
      const s = (v || "").trim().toLowerCase();
      if (s.startsWith("t")) return "Tom";
      if (s.startsWith("b")) return "Britton";
      return null;
    };
    const parseStatus = (v: string) => {
      const s = (v || "").trim().toLowerCase();
      const hit = STATUSES.find((x) => x.id.toLowerCase() === s);
      return hit ? hit.id : "New";
    };
    let start = 0;
    const first = rows[0].toLowerCase();
    if (
      /name/.test(first) &&
      /company|loop|owner|source|community|event|email|phone|linkedin/.test(first)
    )
      start = 1;
    const made = [];
    for (let i = start; i < rows.length; i++) {
      const cols = rows[i].split(/[,\t]/).map((x) => x.trim());
      if (!cols[0]) continue;
      const loops = parseLoops(cols[2]);
      made.push({
        name: cols[0],
        company: cols[1] || "",
        loops,
        owner: parseOwner(cols[3]),
        status: parseStatus(cols[4]),
        source: loops.includes(2) ? cols[5] || "" : "",
        email: cols[6] || "",
        phone: cols[7] || "",
        linkedin: cols[8] || "",
      });
    }
    if (!made.length) {
      patch({
        csvError:
          "Couldn’t read any contacts. Use: Name, Company, Loop, Owner, Status, Source, Email, Phone, LinkedIn",
      });
      return;
    }
    submit({ intent: "importContacts", rows: JSON.stringify(made) });
  };

  // ---- derived ----
  const byView = (c: Contact) =>
    S.view === "all"
      ? true
      : S.view === "loop1"
        ? c.loops.includes(1)
        : c.loops.includes(2);
  const byOwner = (c: Contact) =>
    S.owner === "all"
      ? true
      : S.owner === "unassigned"
        ? !c.owner
        : c.owner === S.owner;
  const q = S.query.trim().toLowerCase();
  const byQuery = (c: Contact) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    c.company.toLowerCase().includes(q);
  const bySource = (c: Contact) =>
    S.sourceFilter === "all" || (c.source || "") === S.sourceFilter;
  const byStage = (c: Contact) =>
    S.stage === "all"
      ? true
      : S.stage === "untouched"
        ? c.touches.length === 0
        : c.status === S.stage;

  // Cross-owner duplicate detection (same name under 2+ owners).
  const nameIndex = buildNameIndex(contacts);

  // Distinct Loop 2 sources present in the data, with counts, for the sidebar.
  const sourceCounts = new Map<string, number>();
  for (const c of contacts) {
    const s = (c.source || "").trim();
    if (s) sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
  }
  const sources = [...sourceCounts.keys()].sort((a, b) => a.localeCompare(b));

  const counts = {
    all: contacts.length,
    loop1: contacts.filter((c) => c.loops.includes(1)).length,
    loop2: contacts.filter((c) => c.loops.includes(2)).length,
  };
  const ownerCounts = {
    all: contacts.length,
    Tom: contacts.filter((c) => c.owner === "Tom").length,
    Britton: contacts.filter((c) => c.owner === "Britton").length,
    unassigned: contacts.filter((c) => !c.owner).length,
  };

  const tabBtn = (active: boolean) =>
    `display:flex;align-items:center;justify-content:space-between;width:100%;padding:7px 8px;border:none;background:${active ? "#eeeee9" : "none"};border-radius:8px;font-size:13px;font-weight:${active ? "500" : "450"};color:${active ? "#1a1a1a" : "#575753"};cursor:pointer;font-family:inherit;margin-bottom:1px;`;
  const viewTabs = [
    { key: "all", label: "All contacts", dot: "#c4c4be", count: counts.all },
    { key: "loop1", label: "Loop 1", dot: "#9a9a95", count: counts.loop1 },
    { key: "loop2", label: "Loop 2", dot: "#e0930a", count: counts.loop2 },
  ].map((t) => ({
    ...t,
    style: tabBtn(S.view === t.key),
    onClick: () => setView(t.key),
  }));

  const ownerTabs = [
    { key: "all", label: "Everyone", count: ownerCounts.all, hasAvatar: false, color: "", initial: "" },
    { key: "Tom", label: "Tom", count: ownerCounts.Tom, hasAvatar: true, color: OWNERS.Tom.color, initial: "T" },
    { key: "Britton", label: "Britton", count: ownerCounts.Britton, hasAvatar: true, color: OWNERS.Britton.color, initial: "B" },
    { key: "unassigned", label: "Unassigned", count: ownerCounts.unassigned, hasAvatar: false, color: "", initial: "" },
  ].map((o) => ({ ...o, style: tabBtn(S.owner === o.key), onClick: () => setOwner(o.key) }));

  // Base set for the SOURCE filter row (Loop 2 only) — everything except the
  // source and stage filters, so per-source counts reflect the current view.
  const sourceBase = contacts.filter(
    (c) => byView(c) && byOwner(c) && byQuery(c),
  );
  const sourceInViewCounts = new Map<string, number>();
  for (const c of sourceBase) {
    const s = (c.source || "").trim();
    if (s) sourceInViewCounts.set(s, (sourceInViewCounts.get(s) ?? 0) + 1);
  }
  const sourcesInView = [...sourceInViewCounts.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  const sourceTabs = sourcesInView.length
    ? [
        { key: "all", label: "All sources", count: sourceBase.length },
        ...sourcesInView.map((s) => ({
          key: s,
          label: s,
          count: sourceInViewCounts.get(s) ?? 0,
        })),
      ].map((t) => ({
        ...t,
        active: S.sourceFilter === t.key,
        onClick: () => setSourceFilter(t.key),
      }))
    : [];

  // Base set for the STAGE filter bar — everything except the stage filter, so
  // the per-stage counts reflect what's reachable under the current view.
  const stageBase = contacts.filter(
    (c) => byView(c) && byOwner(c) && bySource(c) && byQuery(c),
  );
  const stageTabs = [
    { key: "all", label: "All stages", dot: "", count: stageBase.length },
    {
      key: "untouched",
      label: "Not touched",
      dot: "#c4c4be",
      count: stageBase.filter((c) => c.touches.length === 0).length,
    },
    ...STATUSES.map((s) => ({
      key: s.id,
      label: s.id,
      dot: s.dot,
      count: stageBase.filter((c) => c.status === s.id).length,
    })),
  ].map((t) => ({ ...t, active: S.stage === t.key, onClick: () => setStage(t.key) }));

  const visible = stageBase.filter(byStage);

  // ---- selection / bulk actions ----
  const visibleIds = visible.map((c) => c.id);
  const selectedSet = new Set(S.selectedIds);
  const selectedCount = S.selectedIds.length;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedSet.has(id));
  const toggleSelectAll = () =>
    patch((s) => {
      const set = new Set(s.selectedIds);
      if (visibleIds.every((id) => set.has(id))) {
        // all visible already selected → clear just the visible ones
        visibleIds.forEach((id) => set.delete(id));
      } else {
        visibleIds.forEach((id) => set.add(id));
      }
      return { selectedIds: [...set] };
    });
  // Selected contacts that actually have an email — the export subset.
  const selectedContacts = contacts.filter((c) => selectedSet.has(c.id));
  const selectedEmails = selectedContacts
    .map((c) => ({ name: c.name, email: (c.email || "").trim() }))
    .filter((c) => c.email);
  const exportEmails = () => {
    if (!selectedEmails.length) return;
    const esc = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const csv =
      "name,email\n" +
      selectedEmails.map((c) => esc(c.name) + "," + esc(c.email)).join("\n") +
      "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "emails.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const markAdsSent = () => {
    if (!selectedCount) return;
    submit({ intent: "markAdsSent", ids: JSON.stringify(S.selectedIds) });
  };

  const prio = (c: Contact) => {
    if (!c.owner) return 0;
    if (c.followUp !== null && c.followUp <= 0) return 1;
    if (c.status === "Meeting booked") return 2;
    return 3;
  };
  const queueSrc = contacts
    .filter((c) => byView(c) && byOwner(c) && bySource(c))
    .map((c) => ({ c, att: needsAttention(c) }))
    .filter((x) => x.att.flag)
    .sort(
      (a, b) => prio(a.c) - prio(b.c) || (a.c.followUp ?? 99) - (b.c.followUp ?? 99),
    )
    .slice(0, 8);
  const queue = queueSrc.map(({ c, att }) => {
    const o = c.owner ? OWNERS[c.owner] : null;
    const last = c.touches[0];
    const ch = last ? CH[last.ch] : null;
    const m = statusMeta(c.status);
    const urgent = !c.owner || (c.followUp !== null && c.followUp <= 0);
    return {
      name: c.name,
      company: c.company,
      hasSource: c.loops.includes(2) && !!(c.source && c.source.trim()),
      source: (c.source || "").trim(),
      reason: att.reason,
      ownerColor: o ? o.color : "#b0b0aa",
      ownerInitial: o ? o.initial : "?",
      status: c.status,
      statusStyle: statusPill(c.status, false),
      statusDot: m.dot,
      touchChannel: ch ? ch.label : "No touch",
      touchAgo: last ? ago(last.daysAgo) : "—",
      touchIconHtml: { __html: ch ? ch.icon : "" },
      touchWrap: `width:20px;height:20px;border-radius:5px;background:${ch ? ch.bg : "#f2f2f0"};color:${ch ? ch.fg : "#a3a39d"};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
      loops: c.loops.map((l) => loopBadge(l, true)),
      reasonColor: urgent ? "#c2410c" : "#75756f",
      border: urgent ? "#f6cfa2" : "#ededea",
      bg: urgent ? "#fffaf2" : "#ffffff",
      onClick: () => open(c.id),
    };
  });

  const rows = visible.map((c) => {
    const last = c.touches[0];
    const ch = last
      ? CH[last.ch]
      : { label: "No touch yet", bg: "#f2f2f0", fg: "#a3a39d", icon: NO_TOUCH_ICON };
    const conflict = hasNameConflict(c, nameIndex);
    const o = c.owner ? OWNERS[c.owner] : null;
    const m = statusMeta(c.status);
    const statusMenu = STATUSES.map((s) => ({
      label: s.id,
      dot: s.dot,
      active: s.id === c.status,
      onClick: (e: any) => setStatus(c.id, s.id, e),
      style:
        "display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:none;background:none;border-radius:7px;font-size:12.5px;font-family:inherit;color:#2a2a28;cursor:pointer;text-align:left;",
    }));
    return {
      id: c.id,
      name: c.name,
      company: c.company,
      selected: selectedSet.has(c.id),
      onToggleSelect: (e: any) => toggleSelect(c.id, e),
      hasConflict: conflict,
      hasLinkedin: !!linkedinUrl(c.linkedin),
      linkedinHref: linkedinUrl(c.linkedin),
      hasSource: c.loops.includes(2) && !!(c.source && c.source.trim()),
      source: (c.source || "").trim(),
      loops: c.loops.map((l) => loopBadge(l, true)),
      touch: {
        channel: ch.label,
        ago: last ? ago(last.daysAgo) : "—",
        iconHtml: { __html: ch.icon },
        iconWrap: `width:22px;height:22px;border-radius:6px;background:${ch.bg};color:${ch.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
      },
      status: c.status,
      statusDot: m.dot,
      statusStyle: statusPill(c.status, false),
      menuOpen: S.menuId === c.id,
      toggleMenu: (e: any) => toggleMenu(c.id, e),
      stopProp: (e: any) => e.stopPropagation(),
      statusMenu,
      ownerColor: o ? o.color : "#b0b0aa",
      ownerInitial: o ? o.initial : "?",
      ownerName: c.owner || "Unassigned",
      onOpen: () => open(c.id),
      rowStyle: "border-bottom:1px solid #f2f2f0;",
    };
  });

  // detail
  const sel = contacts.find((c) => c.id === S.selectedId) || null;
  let detail: any = null;
  if (sel) {
    const o = sel.owner ? OWNERS[sel.owner] : null;
    const m = statusMeta(sel.status);
    const conflictWith = conflictOwners(sel, nameIndex);
    const conflict = conflictWith.length > 0;
    const lastT = sel.touches[0];
    const detailMenu = STATUSES.map((s) => ({
      label: s.id,
      dot: s.dot,
      active: s.id === sel.status,
      onClick: (e: any) => setStatus(sel.id, s.id, e),
      style:
        "display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:none;background:none;border-radius:7px;font-size:12.5px;font-family:inherit;color:#2a2a28;cursor:pointer;text-align:left;",
    }));
    let followLabel: string;
    let followColor = "#75756f";
    let hasFollow = false;
    let snoozeLabel = "Set follow-up";
    if (sel.followUp !== null) {
      hasFollow = true;
      snoozeLabel = "Snooze 3d";
      const due = -sel.followUp;
      if (due <= 0) {
        followLabel = "Due today";
        followColor = "#c2410c";
      } else {
        followLabel =
          "Due in " + due + " day" + (due > 1 ? "s" : "") +
          (sel.followUpDateLabel ? " · " + sel.followUpDateLabel : "");
        followColor = due <= 1 ? "#c2410c" : "#75756f";
      }
    } else {
      followLabel = "No reminder set";
    }
    const vc = OWNERS[VIEWER];
    // Contact-info rows — only the channels that have a value. Icons reuse the
    // channel SVG strings from CH (rendered via dangerouslySetInnerHTML below).
    const linkedinRaw = (sel.linkedin || "").trim();
    const linkedinHref = linkedinRaw
      ? /^https?:\/\//i.test(linkedinRaw)
        ? linkedinRaw
        : "https://" + linkedinRaw
      : "";
    const contactInfo = [
      sel.email && sel.email.trim()
        ? {
            iconHtml: { __html: CH.email.icon },
            iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.email.bg};color:${CH.email.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
            label: sel.email.trim(),
            href: "mailto:" + sel.email.trim(),
            external: false,
          }
        : null,
      sel.phone && sel.phone.trim()
        ? {
            iconHtml: { __html: CH.call.icon },
            iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.call.bg};color:${CH.call.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
            label: sel.phone.trim(),
            href: "tel:" + sel.phone.trim().replace(/[^\d+]/g, ""),
            external: false,
          }
        : null,
      linkedinRaw
        ? {
            iconHtml: { __html: CH.linkedin.icon },
            iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.linkedin.bg};color:${CH.linkedin.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
            label: linkedinRaw.replace(/^https?:\/\//i, ""),
            href: linkedinHref,
            external: true,
          }
        : null,
    ].filter(Boolean);
    detail = {
      name: sel.name,
      company: sel.company,
      contactInfo,
      hasContactInfo: contactInfo.length > 0,
      ownerName: sel.owner || "Unassigned",
      ownerColor: o ? o.color : "#b0b0aa",
      ownerInitial: o ? o.initial : "?",
      loops: sel.loops.map((l) => loopBadge(l, false)),
      status: sel.status,
      statusDot: m.dot,
      statusStyle: statusPill(sel.status, true),
      menuOpen: S.detailMenu,
      toggleMenu: () => toggleDetailMenu(),
      statusMenu: detailMenu,
      hasSource: !!(sel.source && sel.source.trim()),
      source: sel.source || "",
      canResume: sel.loops.includes(2) && !sel.resumedToLoop1At,
      isResumed: !!sel.resumedToLoop1At,
      resumedLabel: sel.resumedLabel || null,
      resumeLoop1: () => resumeLoop1(),
      hasConflict: conflict,
      conflictText: conflict
        ? sel.owner
          ? `Also owned by ${conflictWith.join(" & ")} — you both have a contact named “${sel.name}”. Confirm who's driving before the next outreach.`
          : `${conflictWith.join(" & ")} ${conflictWith.length > 1 ? "each have" : "has"} a contact named “${sel.name}”. Assign one owner to avoid double-touching.`
        : "",
      followLabel,
      followColor,
      hasFollow,
      snoozeLabel,
      snoozeFollow: () => snoozeFollow(),
      clearFollow: () => clearFollow(),
      viewerColor: vc.color,
      viewerInitial: vc.initial,
      viewerName: VIEWER,
      hasNotes: sel.notes.length > 0,
      notes: sel.notes.map((n) => ({
        author: n.author,
        ago: ago(n.daysAgo),
        text: n.text,
        color: (OWNERS[n.author] || { color: "#b0b0aa" }).color,
        initial: (OWNERS[n.author] || { initial: "?" }).initial,
      })),
      lastBy: lastT ? lastT.owner : "—",
      timeline: sel.touches.map((t, i) => {
        const c2 = CH[t.ch];
        return {
          channel: c2.label,
          iconHtml: { __html: c2.icon },
          iconWrap: `width:26px;height:26px;border-radius:8px;background:${c2.bg};color:${c2.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
          loopLabel: "Loop " + t.loop,
          loopStyle: loopBadge(t.loop, true).style,
          date: fmtDate(t.daysAgo),
          owner: t.owner,
          hasNote: !!t.note,
          note: t.note,
          hasLine: i < sel.touches.length - 1,
        };
      }),
    };
  }

  const headerTitle =
    S.view === "all"
      ? "All contacts"
      : S.view === "loop1"
        ? "Loop 1 · always-on"
        : "Loop 2 · community blitz";
  const headerSub =
    visible.length +
    " contact" +
    (visible.length === 1 ? "" : "s") +
    (S.owner === "all" ? "" : " · " + (S.owner === "unassigned" ? "unassigned" : S.owner));

  // modal derived
  const f = S.form;
  const inputStyle =
    "width:100%;padding:9px 11px;border:1px solid #e6e6e2;border-radius:9px;font-size:13px;font-family:inherit;background:#fff;outline:none;color:#1a1a1a;";
  const loopChip = (n: number, on: boolean) => {
    const amber = n === 2;
    return on
      ? `display:flex;align-items:center;gap:7px;padding:9px 13px;border-radius:9px;border:1px solid ${amber ? "#e5a53a" : "#c9c9c3"};background:${amber ? "#fdf0d9" : "#f0f0ec"};color:${amber ? "#b45309" : "#3a3a38"};font-size:13px;font-weight:500;font-family:inherit;cursor:pointer;`
      : `display:flex;align-items:center;gap:7px;padding:9px 13px;border-radius:9px;border:1px solid #e6e6e2;background:#fff;color:#75756f;font-size:13px;font-weight:450;font-family:inherit;cursor:pointer;`;
  };
  const ownerChoice = (on: boolean) =>
    `display:flex;align-items:center;gap:7px;padding:9px 13px;border-radius:9px;border:1px solid ${on ? "#c9c9c3" : "#e6e6e2"};background:${on ? "#f0f0ec" : "#fff"};color:${on ? "#1a1a1a" : "#75756f"};font-size:13px;font-weight:${on ? "500" : "450"};font-family:inherit;cursor:pointer;`;
  const formOwners = ["Tom", "Britton", "Unassigned"].map((o) => ({
    label: o,
    style: ownerChoice(f.owner === o),
    onClick: () => setForm({ owner: o }),
    hasAvatar: o !== "Unassigned",
    color: (OWNERS[o] || { color: "" }).color,
    initial: (OWNERS[o] || { initial: "" }).initial,
  }));

  return (
    <div className="slcrm" style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      {/* SIDEBAR */}
      <aside style={css("width:236px; flex:0 0 236px; border-right:1px solid #ededea; background:#fbfbfa; display:flex; flex-direction:column; padding:16px 12px;")}>
        <div style={css("display:flex; align-items:center; gap:9px; padding:4px 8px 16px 8px;")}>
          <div style={css("width:24px; height:24px; border-radius:6px; background:#1a1a1a; color:#fff; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600;")}>S</div>
          <div style={css("font-size:14px; font-weight:600; letter-spacing:-0.01em;")}>Sales Loops</div>
        </div>

        <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; padding:8px 8px 6px;")}>Views</div>
        {viewTabs.map((tab) => (
          <Box as="button" key={tab.key} onClick={tab.onClick} style={css(tab.style)} hover={css("background:#f0f0ec;")}>
            <span style={css("display:flex; align-items:center; gap:9px;")}>
              <span style={css(`width:8px; height:8px; border-radius:3px; background:${tab.dot};`)} />
              <span>{tab.label}</span>
            </span>
            <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{tab.count}</span>
          </Box>
        ))}

        <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; padding:18px 8px 6px;")}>Owner</div>
        {ownerTabs.map((o) => (
          <Box as="button" key={o.key} onClick={o.onClick} style={css(o.style)} hover={css("background:#f0f0ec;")}>
            <span style={css("display:flex; align-items:center; gap:9px;")}>
              {o.hasAvatar && (
                <span style={css(`width:18px; height:18px; border-radius:5px; background:${o.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600;`)}>{o.initial}</span>
              )}
              <span>{o.label}</span>
            </span>
            <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{o.count}</span>
          </Box>
        ))}

        <div style={css("margin-top:auto; padding:12px 8px; border-top:1px solid #ededea; font-size:11px; color:#a3a39d; line-height:1.5;")}>
          <div><span style={css("color:#575753;")}>Loop 1</span> · always-on outbound</div>
          <div><span style={css("color:#b45309;")}>Loop 2</span> · event/community blitz</div>
        </div>
      </aside>

      {/* MAIN */}
      <main style={css("flex:1; display:flex; flex-direction:column; min-width:0; background:#ffffff;")}>
        <div style={css("display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #ededea;")}>
          <div style={css("min-width:0;")}>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>{headerTitle}</div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:1px;")}>{headerSub}</div>
          </div>
          <div style={css("flex:1;")} />
          <div style={css("position:relative; width:260px;")}>
            <IconSearch style={css("position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#b0b0aa;")} />
            <Box
              as="input"
              value={S.query}
              onChange={onSearch}
              placeholder="Search name or company…"
              style={css("width:100%; padding:8px 12px 8px 32px; border:1px solid #e6e6e2; border-radius:8px; font-size:13px; font-family:inherit; background:#fbfbfa; outline:none; color:#1a1a1a;")}
              focus={css("border-color:#c9c9c3; background:#fff;")}
            />
          </div>
          <Box as="button" onClick={openCsv} style={css("display:flex; align-items:center; gap:6px; padding:8px 12px; border:1px solid #e6e6e2; background:#fff; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#3a3a38; cursor:pointer; white-space:nowrap;")} hover={css("background:#f4f4f1;")}>
            <IconUpload />
            Import CSV
          </Box>
          <Box as="button" onClick={openAdd} style={css("display:flex; align-items:center; gap:6px; padding:8px 13px; border:none; background:#1a1a1a; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#fff; cursor:pointer; white-space:nowrap;")} hover={css("background:#333;")}>
            <IconPlus />
            Add contact
          </Box>
        </div>

        <div style={css("flex:1; overflow-y:auto; overflow-x:hidden;")}>
          {S.view === "loop2" && sourceTabs.length > 0 && (
            <div style={css("display:flex; align-items:center; gap:8px; padding:14px 24px 2px; flex-wrap:wrap;")}>
              <span style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; margin-right:2px;")}>Source</span>
              {sourceTabs.map((t) => (
                <Box
                  as="button"
                  key={t.key}
                  onClick={t.onClick}
                  style={css(
                    `display:inline-flex; align-items:center; gap:6px; padding:5px 11px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer; white-space:nowrap; border:1px solid ${t.active ? (t.key === "all" ? "#d8d8d3" : "#f0e4cf") : "transparent"}; background:${t.active ? (t.key === "all" ? "#eeeee9" : "#faf3e6") : "none"}; color:${t.active ? (t.key === "all" ? "#1a1a1a" : "#9a6f34") : "#575753"}; font-weight:${t.active ? "500" : "450"};`,
                  )}
                  hover={css("background:#f4f4f1;")}
                >
                  {t.key !== "all" && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={css("flex:0 0 auto; color:#c69a4f;")}>
                      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      <path d="M12 6v12" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.5 2.5" />
                    </svg>
                  )}
                  {t.label}
                  <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{t.count}</span>
                </Box>
              ))}
            </div>
          )}
          <div style={css("display:flex; align-items:center; gap:8px; padding:14px 24px 2px; flex-wrap:wrap;")}>
            <span style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; margin-right:2px;")}>Stage</span>
            {stageTabs.map((t) => (
              <Box
                as="button"
                key={t.key}
                onClick={t.onClick}
                style={css(
                  `display:inline-flex; align-items:center; gap:6px; padding:5px 11px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer; white-space:nowrap; border:1px solid ${t.active ? "#d8d8d3" : "transparent"}; background:${t.active ? "#eeeee9" : "none"}; color:${t.active ? "#1a1a1a" : "#575753"}; font-weight:${t.active ? "500" : "450"};`,
                )}
                hover={css("background:#f4f4f1;")}
              >
                {t.dot && <span style={css(`width:6px; height:6px; border-radius:4px; background:${t.dot};`)} />}
                {t.label}
                <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{t.count}</span>
              </Box>
            ))}
          </div>
          {queue.length > 0 && (
            <div style={css("padding:16px 24px 4px;")}>
              <div style={css("display:flex; align-items:center; gap:8px; margin-bottom:10px;")}>
                <IconWarn style={css("color:#c2410c;")} />
                <span style={css("font-size:12.5px; font-weight:600; color:#3a3a38;")}>Needs attention</span>
                <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{queue.length}</span>
              </div>
              <div style={css("display:grid; grid-template-columns:repeat(auto-fill, minmax(258px, 1fr)); gap:10px;")}>
                {queue.map((qc, i) => (
                  <Box
                    as="button"
                    key={i}
                    onClick={qc.onClick}
                    style={css(`display:flex; flex-direction:column; gap:10px; padding:13px 14px; border:1px solid ${qc.border}; background:${qc.bg}; border-radius:12px; cursor:pointer; font-family:inherit; text-align:left;`)}
                    hover={css("border-color:#d4d4ce; box-shadow:0 2px 8px rgba(0,0,0,0.05);")}
                  >
                    <span style={css("display:flex; align-items:center; gap:10px; width:100%;")}>
                      <span style={css(`width:30px; height:30px; border-radius:8px; background:${qc.ownerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; flex:0 0 auto;`)}>{qc.ownerInitial}</span>
                      <span style={css("display:flex; flex-direction:column; gap:1px; min-width:0; flex:1;")}>
                        <span style={css("font-size:13.5px; font-weight:500; color:#1a1a1a; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;")}>{qc.name}</span>
                        <span style={css("display:flex; align-items:center; gap:5px; min-width:0;")}>
                          <span style={css("font-size:11.5px; color:#9a9a95; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;")}>{qc.company}</span>
                          {qc.hasSource && <SourceTag label={qc.source} />}
                        </span>
                      </span>
                      <span style={css("display:flex; gap:3px; flex:0 0 auto;")}>
                        {qc.loops.map((lp, j) => (
                          <span key={j} style={css(lp.style)}>{lp.label}</span>
                        ))}
                      </span>
                    </span>
                    <span style={css("display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%;")}>
                      <span style={css("display:flex; align-items:center; gap:6px; min-width:0;")}>
                        <span style={css(qc.touchWrap)}><span dangerouslySetInnerHTML={qc.touchIconHtml} style={css("display:flex;")} /></span>
                        <span style={css("font-size:11.5px; color:#75756f; white-space:nowrap;")}>{qc.touchChannel} · <span style={css(MONO + "color:#a3a39d;")}>{qc.touchAgo}</span></span>
                      </span>
                      <span style={css(qc.statusStyle)}><span style={css(`width:6px; height:6px; border-radius:4px; background:${qc.statusDot};`)} />{qc.status}</span>
                    </span>
                    <span style={{ ...css("display:flex; align-items:center; gap:6px; width:100%; padding-top:9px; border-top:1px solid rgba(0,0,0,0.055); font-size:12px; font-weight:500;"), color: qc.reasonColor }}>
                      <IconWarn size={13} style={css("flex:0 0 auto;")} />
                      {qc.reason}
                    </span>
                  </Box>
                ))}
              </div>
            </div>
          )}

          <div style={css("padding:16px 24px 40px;")}>
            <div style={css("display:grid; grid-template-columns:28px minmax(0,2.4fr) 88px minmax(0,1.3fr) 132px 44px 40px; gap:12px; padding:0 10px 8px; font-size:11px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.04em; align-items:center;")}>
              <div style={css("display:flex; align-items:center;")}>
                {visible.length > 0 && (
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    onClick={toggleSelectAll}
                    title={allVisibleSelected ? "Clear selection" : "Select all"}
                  />
                )}
              </div>
              <div>Contact</div>
              <div>Loops</div>
              <div>Last touch</div>
              <div>Status</div>
              <div style={css("text-align:center;")}>Owner</div>
              <div />
            </div>

            <div style={css("border:1px solid #ededea; border-radius:11px; overflow:hidden; background:#fff;")}>
              {rows.map((row) => (
                <div key={row.id} style={css(row.rowStyle)}>
                  <Box onClick={row.onOpen} style={css(`display:grid; grid-template-columns:28px minmax(0,2.4fr) 88px minmax(0,1.3fr) 132px 44px 40px; gap:12px; align-items:center; padding:11px 10px; cursor:pointer; background:${row.selected ? "#f6f7fb" : "transparent"};`)} hover={css("background:#fafaf9;")}>
                    <div style={css("display:flex; align-items:center;")} onClick={row.stopProp}>
                      <Checkbox checked={row.selected} onClick={row.onToggleSelect} title="Select contact" />
                    </div>
                    <div style={css("display:flex; align-items:center; gap:10px; min-width:0;")}>
                      {row.hasConflict && (
                        <span title="Both teammates involved" style={css("flex:0 0 auto; width:6px; height:6px; border-radius:4px; background:#dc2626;")} />
                      )}
                      <div style={css("min-width:0;")}>
                        <div style={css("display:flex; align-items:center; gap:6px; min-width:0;")}>
                          <span style={css("font-size:13.5px; font-weight:500; color:#1a1a1a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.25;")}>{row.name}</span>
                          {row.hasLinkedin && <LinkedinButton href={row.linkedinHref} stopProp={row.stopProp} />}
                        </div>
                        <div style={css("display:flex; align-items:center; gap:6px; min-width:0;")}>
                          <span style={css("font-size:12px; color:#9a9a95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.25;")}>{row.company}</span>
                          {row.hasSource && <SourceTag label={row.source} />}
                        </div>
                      </div>
                    </div>
                    <div style={css("display:flex; gap:4px;")}>
                      {row.loops.map((lp, j) => (
                        <span key={j} title={lp.title} style={css(lp.style)}>{lp.label}</span>
                      ))}
                    </div>
                    <div style={css("display:flex; align-items:center; gap:7px; min-width:0;")}>
                      <span style={css(row.touch.iconWrap)}>
                        <span dangerouslySetInnerHTML={row.touch.iconHtml} style={css("display:flex;")} />
                      </span>
                      <span style={css("display:flex; flex-direction:column; min-width:0;")}>
                        <span style={css("font-size:12.5px; color:#3a3a38; line-height:1.2; white-space:nowrap;")}>{row.touch.channel}</span>
                        <span style={css("font-size:11px; color:#a3a39d; line-height:1.2;" + MONO)}>{row.touch.ago}</span>
                      </span>
                    </div>
                    <div style={css("position:relative;")} onClick={row.stopProp}>
                      <Box as="button" onClick={row.toggleMenu} style={css(row.statusStyle)} hover={css("filter:brightness(0.97);")}>
                        <span style={css(`width:6px; height:6px; border-radius:4px; background:${row.statusDot};`)} />
                        {row.status}
                        <IconChevronDown style={css("margin-left:1px; opacity:0.5;")} />
                      </Box>
                      {row.menuOpen && (
                        <div style={css("position:absolute; top:calc(100% + 4px); left:0; z-index:40; background:#fff; border:1px solid #e6e6e2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:4px; min-width:150px; animation:slcrm-fadeIn 0.1s ease;")}>
                          {row.statusMenu.map((opt, j) => (
                            <Box as="button" key={j} onClick={opt.onClick} style={css(opt.style)} hover={css("background:#f4f4f1;")}>
                              <span style={css(`width:6px; height:6px; border-radius:4px; background:${opt.dot};`)} />
                              {opt.label}
                              {opt.active && <IconCheck style={css("margin-left:auto; color:#3a3a38;")} />}
                            </Box>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={css("display:flex; justify-content:center;")}>
                      <span title={row.ownerName} style={css(`width:24px; height:24px; border-radius:7px; background:${row.ownerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600;`)}>{row.ownerInitial}</span>
                    </div>
                    <div style={css("display:flex; justify-content:center; color:#c4c4be;")}>
                      <IconChevronRight />
                    </div>
                  </Box>
                </div>
              ))}
            </div>
            {visible.length === 0 && (
              <div style={css("text-align:center; padding:48px; color:#a3a39d; font-size:13px;")}>No contacts match this view.</div>
            )}
          </div>
        </div>
      </main>

      {/* BULK ACTION BAR */}
      {selectedCount > 0 && (
        <div style={css("position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:45; display:flex; align-items:center; gap:8px; padding:8px 8px 8px 16px; background:#1a1a1a; border-radius:12px; box-shadow:0 12px 32px rgba(0,0,0,0.28); animation:slcrm-slideDown 0.16s ease;")}>
          <span style={css("font-size:13px; font-weight:500; color:#fff; white-space:nowrap;")}>{selectedCount} selected</span>
          <span style={css("width:1px; height:20px; background:rgba(255,255,255,0.16); margin:0 2px;")} />
          <Box
            as="button"
            onClick={exportEmails}
            disabled={selectedEmails.length === 0}
            title={selectedEmails.length === 0 ? "None of the selected contacts have an email" : `Export ${selectedEmails.length} email${selectedEmails.length === 1 ? "" : "s"} as CSV`}
            style={css(`display:flex; align-items:center; gap:7px; padding:7px 12px; border:none; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; background:rgba(255,255,255,0.12); color:#fff; cursor:${selectedEmails.length === 0 ? "default" : "pointer"}; opacity:${selectedEmails.length === 0 ? "0.45" : "1"}; white-space:nowrap;`)}
            hover={css(selectedEmails.length === 0 ? "" : "background:rgba(255,255,255,0.2);")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 4v10m0 0-4-4m4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 18v1a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            Export emails
          </Box>
          <Box
            as="button"
            onClick={markAdsSent}
            title="Log a Dark-ad touchpoint (today) for every selected contact"
            style={css("display:flex; align-items:center; gap:7px; padding:7px 13px; border:none; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; background:#6d3fc4; color:#fff; cursor:pointer; white-space:nowrap;")}
            hover={css("background:#7d4ed6;")}
          >
            <span style={css("display:flex; color:#fff;")} dangerouslySetInnerHTML={{ __html: CH.ad.icon }} />
            Mark ads sent
          </Box>
          <Box
            as="button"
            onClick={clearSelection}
            title="Clear selection"
            style={css("display:flex; align-items:center; justify-content:center; width:30px; height:30px; border:none; border-radius:8px; background:rgba(255,255,255,0.08); color:#cfcfcf; cursor:pointer; flex:0 0 auto;")}
            hover={css("background:rgba(255,255,255,0.16);")}
          >
            <IconClose size={15} />
          </Box>
        </div>
      )}

      {/* DETAIL SLIDE-OVER */}
      {detail && (
        <>
          <div onClick={close} style={css("position:fixed; inset:0; background:rgba(20,20,18,0.18); z-index:50; animation:slcrm-fadeIn 0.15s ease;")} />
          <div style={css("position:fixed; top:0; right:0; bottom:0; width:480px; max-width:92vw; background:#fff; z-index:51; box-shadow:-8px 0 40px rgba(0,0,0,0.1); display:flex; flex-direction:column; animation:slcrm-slideIn 0.18s cubic-bezier(0.2,0.8,0.2,1);")}>
            <div style={css("padding:20px 24px 16px; border-bottom:1px solid #ededea;")}>
              <div style={css("display:flex; align-items:flex-start; gap:12px;")}>
                <span style={css(`width:38px; height:38px; border-radius:10px; background:${detail.ownerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:600; flex:0 0 auto;`)}>{detail.ownerInitial}</span>
                <div style={css("flex:1; min-width:0;")}>
                  <div style={css("font-size:18px; font-weight:600; letter-spacing:-0.015em; line-height:1.2;")}>{detail.name}</div>
                  <div style={css("font-size:13px; color:#9a9a95; margin-top:2px;")}>{detail.company} · owned by {detail.ownerName}</div>
                  {detail.hasSource && (
                    <div style={css("font-size:12.5px; color:#b45309; margin-top:3px; display:flex; align-items:center; gap:5px;")}>
                      <span style={css("width:6px; height:6px; border-radius:3px; background:#e0930a; flex:0 0 auto;")} />
                      From {detail.source}
                    </div>
                  )}
                </div>
                <Box as="button" onClick={close} style={css("border:none; background:#f2f2ef; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66; flex:0 0 auto;")} hover={css("background:#e8e8e4;")}>
                  <IconClose />
                </Box>
              </div>
              <div style={css("display:flex; align-items:center; gap:8px; margin-top:14px; flex-wrap:wrap;")}>
                {detail.loops.map((lp: any, j: number) => (
                  <span key={j} style={css(lp.style)}>{lp.label}</span>
                ))}
                <div style={css("position:relative;")}>
                  <Box as="button" onClick={detail.toggleMenu} style={css(detail.statusStyle)} hover={css("filter:brightness(0.97);")}>
                    <span style={css(`width:6px; height:6px; border-radius:4px; background:${detail.statusDot};`)} />
                    {detail.status}
                    <IconChevronDown style={css("opacity:0.5;")} />
                  </Box>
                  {detail.menuOpen && (
                    <div style={css("position:absolute; top:calc(100% + 4px); left:0; z-index:20; background:#fff; border:1px solid #e6e6e2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:4px; min-width:150px;")}>
                      {detail.statusMenu.map((opt: any, j: number) => (
                        <Box as="button" key={j} onClick={opt.onClick} style={css(opt.style)} hover={css("background:#f4f4f1;")}>
                          <span style={css(`width:6px; height:6px; border-radius:4px; background:${opt.dot};`)} />
                          {opt.label}
                          {opt.active && <IconCheck style={css("margin-left:auto; color:#3a3a38;")} />}
                        </Box>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={css("flex:1; overflow-y:auto; padding:0 24px 24px;")}>
              {detail.hasConflict && (
                <div style={css("display:flex; gap:10px; align-items:flex-start; background:#fef2f2; border:1px solid #fbd5d5; border-radius:10px; padding:12px 14px; margin-top:16px;")}>
                  <IconWarn size={16} style={css("color:#dc2626; flex:0 0 auto; margin-top:1px;")} />
                  <div style={css("font-size:12.5px; color:#991b1b; line-height:1.45;")}>{detail.conflictText}</div>
                </div>
              )}

              {detail.hasContactInfo && (
                <div style={css("margin-top:16px;")}>
                  <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;")}>Contact info</div>
                  <div style={css("border:1px solid #ededea; border-radius:11px; overflow:hidden; background:#fff;")}>
                    {detail.contactInfo.map((ci: any, j: number) => (
                      <Box
                        as="a"
                        key={j}
                        href={ci.href}
                        {...(ci.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                        style={css(`display:flex; align-items:center; gap:11px; padding:11px 13px; text-decoration:none; color:#2a2a28; ${j > 0 ? "border-top:1px solid #f2f2f0;" : ""}`)}
                        hover={css("background:#faf9f6;")}
                      >
                        <span style={css(ci.iconWrap)}>
                          <span dangerouslySetInnerHTML={ci.iconHtml} style={css("display:flex;")} />
                        </span>
                        <span style={css("font-size:13px; color:#2a2a28; word-break:break-all; min-width:0; flex:1;")}>{ci.label}</span>
                        {ci.external && <IconChevronRight />}
                      </Box>
                    ))}
                  </div>
                </div>
              )}

              <div style={css("margin-top:16px; border:1px solid #ededea; border-radius:11px; padding:14px; background:#fbfbfa;")}>
                <div style={css("display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
                  <div style={css("display:flex; align-items:center; gap:9px;")}>
                    <IconCalendar style={css(`color:${detail.followColor};`)} />
                    <div>
                      <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>Follow-up</div>
                      <div style={css(`font-size:12px; color:${detail.followColor}; margin-top:1px;`)}>{detail.followLabel}</div>
                    </div>
                  </div>
                  <div style={css("display:flex; gap:6px;")}>
                    {detail.hasFollow && (
                      <Box as="button" onClick={detail.clearFollow} style={css("border:1px solid #e6e6e2; background:#fff; padding:6px 11px; border-radius:8px; font-size:12px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Mark done</Box>
                    )}
                    <Box as="button" onClick={detail.snoozeFollow} style={css("border:1px solid #e6e6e2; background:#fff; padding:6px 11px; border-radius:8px; font-size:12px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>{detail.snoozeLabel}</Box>
                  </div>
                </div>
              </div>

              {detail.canResume && (
                <div style={css("margin-top:12px; border:1px solid #ededea; border-radius:11px; padding:14px; background:#fbfbfa; display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
                  <div style={css("min-width:0;")}>
                    <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>Didn’t convert?</div>
                    <div style={css("font-size:12px; color:#75756f; margin-top:1px;")}>Resume this Loop 2 contact into Loop 1 outbound.</div>
                  </div>
                  <Box as="button" onClick={detail.resumeLoop1} style={css("border:1px solid #e6e6e2; background:#fff; padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:pointer; color:#3a3a38; white-space:nowrap; flex:0 0 auto;")} hover={css("background:#f4f4f1;")}>Resume to Loop 1</Box>
                </div>
              )}
              {detail.isResumed && (
                <div style={css("margin-top:12px; display:flex; align-items:center; gap:8px; background:#f0f0ec; border:1px solid #e6e6e2; border-radius:10px; padding:10px 14px; font-size:12.5px; color:#575753;")}>
                  <IconCheck style={css("color:#1f7a4d; flex:0 0 auto;")} />
                  {detail.resumedLabel}
                </div>
              )}

              <div style={css("margin-top:18px;")}>
                <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;")}>Quick note</div>
                <div style={css("display:flex; gap:8px; align-items:flex-start;")}>
                  <span style={css(`width:26px; height:26px; border-radius:7px; background:${detail.viewerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto; margin-top:2px;`)}>{detail.viewerInitial}</span>
                  <div style={css("flex:1;")}>
                    <Box
                      as="textarea"
                      value={S.noteDraft}
                      onChange={onNoteInput}
                      onKeyDown={onNoteKey}
                      placeholder={`Add a note as ${detail.viewerName}… (⌘↵ to save)`}
                      style={css("width:100%; min-height:58px; resize:vertical; padding:9px 11px; border:1px solid #e6e6e2; border-radius:9px; font-size:13px; font-family:inherit; background:#fff; outline:none; color:#1a1a1a; line-height:1.5;")}
                      focus={css("border-color:#c9c9c3;")}
                    />
                    <div style={css("display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:7px;")}>
                      <Box as="button" onClick={logMeeting} style={css("display:flex; align-items:center; gap:6px; border:1px solid #e6e6e2; background:#fff; color:#575753; padding:7px 12px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer;")} hover={css("background:#f4f4f1;")}>
                        <IconCalendar style={css("width:14px; height:14px; color:#75756f;")} />
                        Log as meeting note
                      </Box>
                      <button onClick={addNote} style={css("border:none; background:#1a1a1a; color:#fff; padding:7px 14px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:pointer;")}>Add note</button>
                    </div>
                  </div>
                </div>
              </div>

              {detail.hasNotes && (
                <div style={css("margin-top:12px; display:flex; flex-direction:column; gap:8px;")}>
                  {detail.notes.map((n: any, j: number) => (
                    <div key={j} style={css("display:flex; gap:9px; padding:11px 12px; background:#faf9f6; border:1px solid #efeee9; border-radius:10px;")}>
                      <span style={css(`width:22px; height:22px; border-radius:6px; background:${n.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto; margin-top:1px;`)}>{n.initial}</span>
                      <div style={css("min-width:0;")}>
                        <div style={css("font-size:11.5px; color:#9a9a95; margin-bottom:2px;")}><span style={css("color:#575753; font-weight:500;")}>{n.author}</span> · {n.ago}</div>
                        <div style={css("font-size:13px; color:#2a2a28; line-height:1.5; white-space:pre-wrap;")}>{n.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={css("margin-top:22px;")}>
                <div style={css("display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;")}>
                  <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em;")}>Touchpoint history</div>
                  <div style={css("font-size:11.5px; color:#a3a39d;")}>Last reached by <span style={css("color:#3a3a38; font-weight:500;")}>{detail.lastBy}</span></div>
                </div>
                <div style={css("position:relative; padding-left:4px;")}>
                  {detail.timeline.map((t: any, j: number) => (
                    <div key={j} style={css("display:grid; grid-template-columns:26px 1fr; gap:12px; padding-bottom:16px; position:relative;")}>
                      <div style={css("display:flex; flex-direction:column; align-items:center;")}>
                        <span style={css(t.iconWrap)}><span dangerouslySetInnerHTML={t.iconHtml} style={css("display:flex;")} /></span>
                        {t.hasLine && <span style={css("width:2px; flex:1; background:#ededea; margin-top:4px;")} />}
                      </div>
                      <div style={css("padding-top:1px;")}>
                        <div style={css("display:flex; align-items:center; gap:8px; flex-wrap:wrap;")}>
                          <span style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>{t.channel}</span>
                          <span style={css(t.loopStyle)}>{t.loopLabel}</span>
                          <span style={css("font-size:11.5px; color:#a3a39d; margin-left:auto;" + MONO)}>{t.date}</span>
                        </div>
                        <div style={css("font-size:12px; color:#75756f; margin-top:2px;")}>by {t.owner}</div>
                        {t.hasNote && (
                          <div style={css("font-size:12.5px; color:#4a4a46; margin-top:5px; line-height:1.45;")}>{t.note}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ADD / IMPORT MODAL */}
      {S.modal && (
        <div onClick={closeModal} style={css("position:fixed; inset:0; background:rgba(20,20,18,0.22); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:72px 20px; animation:slcrm-fadeIn 0.14s ease;")}>
          <div onClick={(e) => e.stopPropagation()} style={css("width:520px; max-width:100%; background:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.22); overflow:hidden; animation:slcrm-slideDown 0.18s cubic-bezier(0.2,0.8,0.2,1);")}>
            {S.modal === "add" && (
              <>
                <div style={css("padding:20px 22px 16px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;")}>
                  <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>Add contact</div>
                  <Box as="button" onClick={closeModal} style={css("border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;")} hover={css("background:#e8e8e4;")}><IconClose size={15} /></Box>
                </div>
                <div style={css("padding:18px 22px 22px; display:flex; flex-direction:column; gap:16px;")}>
                  <div style={css("display:grid; grid-template-columns:1fr 1fr; gap:12px;")}>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Name</span>
                      <Box as="input" value={f.name} onChange={(e: any) => setForm({ name: e.target.value })} placeholder="Full name" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Company</span>
                      <Box as="input" value={f.company} onChange={(e: any) => setForm({ company: e.target.value })} placeholder="Company" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                  </div>
                  <div style={css("display:grid; grid-template-columns:1fr 1fr; gap:12px;")}>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Email</span>
                      <Box as="input" type="email" value={f.email} onChange={(e: any) => setForm({ email: e.target.value })} placeholder="name@company.com" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Phone</span>
                      <Box as="input" value={f.phone} onChange={(e: any) => setForm({ phone: e.target.value })} placeholder="+1 (555) 000-0000" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                  </div>
                  <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                    <span style={css("font-size:12px; font-weight:500; color:#575753;")}>LinkedIn</span>
                    <Box as="input" value={f.linkedin} onChange={(e: any) => setForm({ linkedin: e.target.value })} placeholder="linkedin.com/in/handle" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                  </label>
                  <div style={css("display:flex; flex-direction:column; gap:7px;")}>
                    <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Loops</span>
                    <div style={css("display:flex; gap:8px;")}>
                      <button onClick={() => toggleFormLoop(1)} style={css(loopChip(1, f.loops.includes(1)))}><span style={css("width:8px;height:8px;border-radius:3px;background:#9a9a95;")} />Loop 1 · always-on</button>
                      <button onClick={() => toggleFormLoop(2)} style={css(loopChip(2, f.loops.includes(2)))}><span style={css("width:8px;height:8px;border-radius:3px;background:#e0930a;")} />Loop 2 · blitz</button>
                    </div>
                  </div>
                  {f.loops.includes(2) && (
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Community / Event <span style={css("color:#a3a39d; font-weight:450;")}>· where they came from</span></span>
                      <Box as="input" list="slcrm-sources" value={f.source} onChange={(e: any) => setForm({ source: e.target.value })} placeholder="e.g. Naturally Network Denver, Newtopia" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                      <datalist id="slcrm-sources">
                        {sources.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </label>
                  )}
                  <div style={css("display:flex; flex-direction:column; gap:7px;")}>
                    <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Owner</span>
                    <div style={css("display:flex; gap:8px;")}>
                      {formOwners.map((o, j) => (
                        <button key={j} onClick={o.onClick} style={css(o.style)}>
                          {o.hasAvatar && <span style={css(`width:16px;height:16px;border-radius:5px;background:${o.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;`)}>{o.initial}</span>}
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={css("display:flex; flex-direction:column; gap:7px;")}>
                    <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Status</span>
                    <div style={css("display:flex; gap:7px; flex-wrap:wrap;")}>
                      {STATUSES.map((s) => (
                        <button key={s.id} onClick={() => setForm({ status: s.id })} style={css(`display:flex;align-items:center;gap:7px;padding:7px 11px;border-radius:8px;border:1px solid ${s.id === f.status ? "#c9c9c3" : "#e6e6e2"};background:${s.id === f.status ? "#f4f4f1" : "#fff"};color:#3a3a38;font-size:12.5px;font-family:inherit;cursor:pointer;`)}>
                          <span style={css(`width:6px;height:6px;border-radius:4px;background:${s.dot};`)} />{s.id}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={css("display:flex; justify-content:flex-end; gap:8px; margin-top:2px;")}>
                    <Box as="button" onClick={closeModal} style={css("border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Cancel</Box>
                    <button onClick={submitAdd} style={css(`border:none;background:${f.name.trim() ? "#1a1a1a" : "#c9c9c3"};color:#fff;padding:9px 16px;border-radius:9px;font-size:13px;font-weight:500;font-family:inherit;cursor:${f.name.trim() ? "pointer" : "default"};`)}>Add contact</button>
                  </div>
                </div>
              </>
            )}

            {S.modal === "csv" && (
              <>
                <div style={css("padding:20px 22px 16px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;")}>
                  <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>Import contacts</div>
                  <Box as="button" onClick={closeModal} style={css("border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;")} hover={css("background:#e8e8e4;")}><IconClose size={15} /></Box>
                </div>
                <div style={css("padding:18px 22px 22px; display:flex; flex-direction:column; gap:12px;")}>
                  <Box
                    as="label"
                    onDragOver={onCsvDragOver}
                    onDragEnter={onCsvDragOver}
                    onDragLeave={onCsvDragLeave}
                    onDrop={onCsvDrop}
                    style={css(
                      `display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; padding:24px 18px; border:1.5px dashed ${S.csvDragging ? "#8a8a84" : "#d8d8d3"}; border-radius:12px; background:${S.csvDragging ? "#f4f4f1" : "#fbfbfa"}; cursor:pointer; transition:background 0.12s, border-color 0.12s;`,
                    )}
                    hover={css("background:#f4f4f1; border-color:#c9c9c3;")}
                  >
                    <input type="file" accept=".csv,text/csv" onChange={onCsvFileInput} style={css("display:none;")} />
                    <span style={css("width:34px; height:34px; border-radius:9px; background:#eeeee9; color:#75756f; display:flex; align-items:center; justify-content:center;")}>
                      <IconUpload />
                    </span>
                    <div style={css("font-size:13px; font-weight:500; color:#3a3a38;")}>
                      {S.csvFileName ? `Loaded ${S.csvFileName}` : "Drag & drop a .csv, or click to browse"}
                    </div>
                    <div style={css("font-size:11.5px; color:#a3a39d; line-height:1.5;")}>
                      {S.csvFileName
                        ? "Click Import contacts to finish — or drop another file."
                        : "One contact per line: Name, Company, Loop, Owner, Status, Source, Email, Phone, LinkedIn"}
                    </div>
                  </Box>
                  {S.csvError && <div style={css("font-size:12px; color:#c2410c;")}>{S.csvError}</div>}
                  <div style={css("display:flex; justify-content:flex-end; gap:8px; margin-top:2px;")}>
                    <Box as="button" onClick={closeModal} style={css("border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Cancel</Box>
                    <Box as="button" onClick={importCsv} style={css("border:none; background:#1a1a1a; color:#fff; padding:9px 16px; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:pointer;")} hover={css("background:#333;")}>Import contacts</Box>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
