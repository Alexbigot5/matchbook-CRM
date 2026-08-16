// The /lifecycle view: every contact as a card, in a column per lifecycle stage.
//
// Same idiom as sales-loop-crm.tsx and templates-page.tsx — one client component,
// a `useState` God object holding only UI state, and a single `useFetcher` that
// posts intents to this route's action. No optimistic UI: React Router
// revalidates the loader after each write, so `contacts` (a prop) is the truth.
//
// Columns are a projection of `contacts.status` (see ./lifecycle), not a stored
// field. That means a status changed anywhere else in the app — the contacts
// table, the detail panel, the machine API — moves the card here too, with
// nothing to keep in sync.
//
// SCROLLING: the whole board is ONE scroll container, and columns have no
// vertical scroll of their own. That is deliberate. A per-column `overflow-y`
// clips every card's ⋮ popover to its column, which is the same reason the
// contacts table keeps its status menus inside the single scrolling region.
// The cost is a tall board when one stage is crowded; a clipped menu is worse.
//
// Native drag-and-drop is pointer-only and exposes nothing to keyboard or screen
// reader users, so the ⋮ "Move to" menu is not a convenience — it is the
// accessible path to every move the board can make. Don't remove it as redundant.

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  buildNameIndex,
  CH,
  type Contact,
  hasNameConflict,
  loopBadge,
  type Viewer,
} from "./data";
import {
  computeLifecycleBoard,
  isInStage,
  LIFECYCLE_STAGES,
  type LifecycleStage,
  stageOf,
} from "./lifecycle";
import {
  ContactDetail,
  DeadReasonModal,
  DeleteContactsModal,
  LinkedinButton,
  linkedinUrl,
  needsDeadReason,
  ownerMeta,
  SourceTag,
} from "./contact-detail";
import { buildOwnerTabs, buildViewTabs, Sidebar } from "./sidebar";
import { Box, css, GLOBAL_CSS, IconCheck, IconWarn, MONO } from "./ui";

type State = {
  view: string;
  owner: string;
  /** Contact whose ⋮ "Move to" menu is open. */
  menuId: string | null;
  selectedId: string | null;
  detailMenu: boolean;
  noteDraft: string;
  /** Card currently being dragged; null outside a drag. */
  draggingId: string | null;
  /** Stage the pointer is over during a drag; drives the drop highlight. */
  dragOverStage: string | null;
  modal: string | null;
  deleteIds: string[];
  pendingDeadId: string | null;
  actionError: string;
};

type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const CARD =
  "border:1px solid #ededea; border-radius:12px; background:#fff; padding:12px 13px; display:flex; flex-direction:column; gap:9px;";
const INFO_ROW = "display:flex; align-items:center; gap:8px; min-width:0;";
const INFO_TEXT =
  "font-size:12px; color:#575753; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;";

export function LifecyclePage({ contacts, viewer }: { contacts: Contact[]; viewer: Viewer }) {
  const fetcher = useFetcher();
  const [state, setState] = useState<State>(() => ({
    view: "all",
    owner: "all",
    menuId: null,
    selectedId: null,
    detailMenu: false,
    noteDraft: "",
    draggingId: null,
    dragOverStage: null,
    modal: null,
    deleteIds: [],
    pendingDeadId: null,
    actionError: "",
  }));

  const patch = (u: Partial<State> | ((s: State) => Partial<State>)) =>
    setState((s) => ({ ...s, ...(typeof u === "function" ? u(s) : u) }));

  const S = state;

  const submit = (fields: Record<string, string>) => fetcher.submit(fields, { method: "post" });

  // Reconciles modal/error UI once a submission settles. The data itself comes
  // back through loader revalidation, not from here.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const result = fetcher.data as ActionResult;
    if (result.ok) {
      patch({ modal: null, deleteIds: [], pendingDeadId: null, actionError: "" });
    } else {
      patch({ actionError: result.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // A contact deleted from the panel (or by someone else, after revalidation)
  // must not leave the slide-over open over a row that no longer exists.
  useEffect(() => {
    patch((s) => {
      if (s.selectedId && !contacts.some((c) => c.id === s.selectedId)) {
        return { selectedId: null, detailMenu: false };
      }
      return {};
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);

  // ---- handlers ----
  const open = (id: string) =>
    patch({ selectedId: id, noteDraft: "", menuId: null, detailMenu: false });
  const close = () => patch({ selectedId: null, detailMenu: false });
  const toggleDetailMenu = () => patch((s) => ({ detailMenu: !s.detailMenu }));
  const toggleMenu = (id: string, e?: any) => {
    if (e) e.stopPropagation();
    patch((s) => ({ menuId: s.menuId === id ? null : id }));
  };
  const stopProp = (e: any) => e.stopPropagation();

  // Every status write on this page funnels through here, so the dead-reason
  // prompt covers the detail menu, the ⋮ menu AND a drop onto Churned alike.
  const setStatus = (id: string, status: string, e?: any) => {
    if (e && typeof (e as any).stopPropagation === "function") (e as any).stopPropagation();
    if (needsDeadReason(status)) {
      patch({
        menuId: null,
        detailMenu: false,
        modal: "deadReason",
        pendingDeadId: id,
        actionError: "",
      });
      return;
    }
    patch({ menuId: null, detailMenu: false });
    submit({ intent: "setStatus", id, status });
  };
  const confirmDead = (reason: string) => {
    if (!S.pendingDeadId) return;
    submit({ intent: "setStatus", id: S.pendingDeadId, status: "Dead", reason });
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
  const logTouch = (ch: string) => {
    if (!S.selectedId) return;
    const text = (S.noteDraft || "").trim();
    patch({ noteDraft: "" });
    submit({ intent: "logTouch", id: S.selectedId, ch, text });
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
  const draftOutreach = () => {
    if (!S.selectedId) return;
    submit({ intent: "triggerAgent", id: S.selectedId });
  };

  const closeModal = () =>
    patch({
      modal: null,
      actionError: "",
      deleteIds: [],
      // Dismissing the reason prompt abandons the status change entirely — the
      // contact stays on whatever status it had.
      pendingDeadId: null,
    });
  const askDelete = (ids: string[]) => {
    if (!ids.length) return;
    patch({ modal: "delete", deleteIds: ids, actionError: "", menuId: null, detailMenu: false });
  };
  const confirmDelete = () => {
    if (!S.deleteIds.length) return;
    submit({ intent: "deleteContacts", ids: JSON.stringify(S.deleteIds) });
  };

  // ---- drag and drop ----
  const onDragStart = (id: string) => (e: React.DragEvent) => {
    // Firefox refuses to start a drag without setData.
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    // An absolutely-positioned popover on a card that's flying away would be
    // left anchored to nothing.
    patch({ draggingId: id, menuId: null });
  };
  const onDragEnd = () => patch({ draggingId: null, dragOverStage: null });

  // No onDragLeave: it fires on every child boundary crossing, which makes the
  // highlight flicker. Each column's onDragOver sets the stage (last one wins)
  // and only drop/dragend clear it.
  const onDragOver = (stage: LifecycleStage) => (e: React.DragEvent) => {
    e.preventDefault(); // without this the drop event never fires
    e.dataTransfer.dropEffect = "move";
    if (S.dragOverStage !== stage.id) patch({ dragOverStage: stage.id });
  };

  const onDrop = (stage: LifecycleStage) => (e: React.DragEvent) => {
    e.preventDefault();
    // dataTransfer first: it is only readable during `drop`, and preferring it
    // means a stray text drag from another app yields a string that matches no
    // contact rather than moving whatever was last dragged.
    const id = e.dataTransfer.getData("text/plain") || S.draggingId || "";
    patch({ draggingId: null, dragOverStage: null });
    const c = contacts.find((x) => x.id === id);
    if (!c) return;
    // Dropping onto the column the card already occupies is a no-op. This is what
    // stops a "Meeting booked" contact being demoted to "Replied" by being
    // nudged a few pixels inside Opportunity.
    if (isInStage(c.status, stage.id)) return;
    setStatus(c.id, stage.canonical);
  };

  // ---- derived ----
  const byView = (c: Contact) =>
    S.view === "all" ? true : S.view === "loop1" ? c.loops.includes(1) : c.loops.includes(2);
  const byOwner = (c: Contact) =>
    S.owner === "all" ? true : S.owner === "unassigned" ? !c.owner : c.owner === S.owner;

  // Rail counts are over the unfiltered list; the board is over the filtered one.
  const viewTabs = buildViewTabs(contacts, S.view, (key) => patch({ view: key, menuId: null }));
  const ownerTabs = buildOwnerTabs(contacts, S.owner, (key) => patch({ owner: key, menuId: null }));

  const nameIndex = buildNameIndex(contacts);
  const scoped = contacts.filter((c) => byView(c) && byOwner(c));
  const board = computeLifecycleBoard(scoped);

  const sel = contacts.find((c) => c.id === S.selectedId) || null;
  const deleteTargets = contacts.filter((c) => S.deleteIds.includes(c.id));
  const deletePending = fetcher.state !== "idle";
  const deadTargetName = contacts.find((c) => c.id === S.pendingDeadId)?.name ?? "";

  const scope = [
    S.view === "loop1" ? "Loop 1" : S.view === "loop2" ? "Loop 2" : "",
    S.owner === "all" ? "" : S.owner === "unassigned" ? "unassigned" : S.owner,
  ].filter(Boolean);
  const headerSub =
    `${board.total} contact${board.total === 1 ? "" : "s"} across ${LIFECYCLE_STAGES.length} lifecycle stages` +
    (scope.length ? ` · ${scope.join(" · ")}` : "");

  return (
    <div
      className="slcrm"
      style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar nav="lifecycle" viewTabs={viewTabs} ownerTabs={ownerTabs} viewer={viewer} />

      <main
        style={css("flex:1; display:flex; flex-direction:column; min-width:0; background:#ffffff;")}
      >
        <div
          style={css(
            "display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #ededea;",
          )}
        >
          <div style={css("min-width:0;")}>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>
              Lifecycle
            </div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:1px;")}>{headerSub}</div>
          </div>
        </div>

        {S.actionError && !S.modal && (
          <div
            style={css(
              "margin:12px 24px 0; padding:9px 12px; border:1px solid #eddede; background:#fbf3f3; border-radius:9px; font-size:12.5px; color:#9a5b5b;",
            )}
          >
            {S.actionError}
          </div>
        )}

        {/* The board's single scroll container — see the module header. Unlike
            the other CRM pages this scrolls on BOTH axes and takes no max-width. */}
        <div style={css("flex:1; overflow:auto;")} onClick={() => S.menuId && patch({ menuId: null })}>
          {board.total === 0 ? (
            <div style={css("padding:56px 24px; text-align:center; font-size:13px; color:#a3a39d;")}>
              {contacts.length === 0
                ? "No contacts yet. Add them on the Contacts page."
                : "No contacts match these filters."}
            </div>
          ) : (
            <div style={css("display:flex; align-items:flex-start; gap:14px; padding:18px 24px 48px;")}>
              {board.columns.map((col) => {
                const isOver = S.dragOverStage === col.stage.id;
                return (
                  <section
                    key={col.stage.id}
                    onDragOver={onDragOver(col.stage)}
                    onDrop={onDrop(col.stage)}
                    style={css(
                      `flex:0 0 304px; width:304px; border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:10px; background:${isOver ? col.stage.tint : "#fcfcfb"}; border:1px solid ${isOver ? col.stage.dot : col.stage.border}; transition:background 0.12s ease, border-color 0.12s ease;`,
                    )}
                  >
                    <header style={css("padding:2px 3px;")}>
                      <div style={css("display:flex; align-items:center; gap:8px;")}>
                        <span
                          style={css(
                            `width:8px; height:8px; border-radius:3px; background:${col.stage.dot}; flex:0 0 auto;`,
                          )}
                        />
                        <span
                          style={css(
                            `font-size:13px; font-weight:600; color:${col.stage.fg}; flex:1; min-width:0;`,
                          )}
                        >
                          {col.stage.id}
                        </span>
                        <span style={css(MONO + "font-size:11.5px; color:#a3a39d;")}>
                          {col.count}
                        </span>
                      </div>
                      <div style={css("font-size:11.5px; color:#a3a39d; margin-top:3px;")}>
                        {col.stage.caption}
                      </div>
                    </header>

                    {col.count === 0 ? (
                      <div
                        style={css(
                          "padding:18px 10px; text-align:center; font-size:11.5px; color:#c0c0ba; border:1px dashed #e6e6e2; border-radius:11px;",
                        )}
                      >
                        {isOver ? "Drop to move here" : "Nobody here"}
                      </div>
                    ) : (
                      col.contacts.map((c) => (
                        <LifecycleCard
                          key={c.id}
                          contact={c}
                          dragging={S.draggingId === c.id}
                          menuOpen={S.menuId === c.id}
                          conflict={hasNameConflict(c, nameIndex)}
                          onOpen={() => open(c.id)}
                          onToggleMenu={(e) => toggleMenu(c.id, e)}
                          onMove={(status) => setStatus(c.id, status)}
                          onDragStart={onDragStart(c.id)}
                          onDragEnd={onDragEnd}
                          stopProp={stopProp}
                        />
                      ))
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* DETAIL SLIDE-OVER — the same component the contacts page renders. */}
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
        />
      )}

      {/* MODALS — the overlay is per-page (as on the other two pages); the
          bodies are shared so their copy and rules can't drift. */}
      {S.modal && (
        <div
          onClick={closeModal}
          style={css(
            "position:fixed; inset:0; background:rgba(20,20,18,0.22); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:72px 20px; animation:slcrm-fadeIn 0.14s ease;",
          )}
        >
          <div
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={css(
              "width:520px; max-width:100%; background:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.22); overflow:hidden; animation:slcrm-slideDown 0.18s cubic-bezier(0.2,0.8,0.2,1);",
            )}
          >
            {S.modal === "delete" && (
              <DeleteContactsModal
                targets={deleteTargets}
                pending={deletePending}
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

/**
 * One contact card.
 *
 * The container is a `div` with `role="button"`, not a `<button>` — it nests the
 * ⋮ button and the LinkedIn anchor, and a button inside a button is invalid HTML
 * that React flags on hydration. The contacts table's rows do the same.
 */
function LifecycleCard({
  contact,
  dragging,
  menuOpen,
  conflict,
  onOpen,
  onToggleMenu,
  onMove,
  onDragStart,
  onDragEnd,
  stopProp,
}: {
  contact: Contact;
  dragging: boolean;
  menuOpen: boolean;
  conflict: boolean;
  onOpen: () => void;
  onToggleMenu: (e: any) => void;
  onMove: (status: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  stopProp: (e: any) => void;
}) {
  const o = ownerMeta(contact.owner);
  const ownerColor = o ? o.color : "#b0b0aa";
  const ownerInitial = o ? o.initial : "?";
  const li = linkedinUrl(contact.linkedin);
  const current = stageOf(contact.status);
  // followUp is relative: 0 = due today, negative = due in future, positive =
  // overdue by that many days (see listContacts). Only today-or-overdue shows.
  const followUpDue =
    contact.followUp !== null && contact.followUp >= 0
      ? contact.followUp === 0
        ? "Follow-up due today"
        : `Follow-up ${contact.followUp}d overdue`
      : null;
  const email = (contact.email || "").trim();
  const phone = (contact.phone || "").trim();
  const source = (contact.source || "").trim();

  return (
    <Box
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={css(CARD + `cursor:grab; opacity:${dragging ? "0.45" : "1"};`)}
      hover={css("border-color:#d4d4ce; box-shadow:0 2px 8px rgba(0,0,0,0.05);")}
    >
      <div style={css("display:flex; align-items:flex-start; gap:8px;")}>
        <div style={css("flex:1; min-width:0;")}>
          <div style={css("display:flex; align-items:center; gap:6px; min-width:0;")}>
            {conflict && (
              <span
                title="Also held by another owner"
                style={css("width:6px; height:6px; border-radius:3px; background:#ef4444; flex:0 0 auto;")}
              />
            )}
            <span
              style={css(
                "font-size:13.5px; font-weight:600; color:#1a1a1a; letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;",
              )}
            >
              {contact.name}
            </span>
          </div>
          <div style={css("display:flex; align-items:center; gap:5px; min-width:0; margin-top:2px;")}>
            <span
              style={css(
                "font-size:12px; color:#9a9a95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;",
              )}
            >
              {contact.company}
            </span>
            {source && <SourceTag label={source} />}
          </div>
        </div>

        {/* Keyboard- and screen-reader-accessible equivalent of dragging. */}
        <div style={css("position:relative; flex:0 0 auto;")} onClick={stopProp}>
          <Box
            as="button"
            draggable={false}
            onClick={onToggleMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Move ${contact.name} to another stage`}
            style={css(
              "border:none; background:none; width:22px; height:22px; border-radius:6px; cursor:pointer; color:#a3a39d; display:flex; align-items:center; justify-content:center; font-family:inherit; padding:0;",
            )}
            hover={css("background:#f0f0ec; color:#575753;")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </Box>
          {menuOpen && (
            <div
              role="menu"
              style={css(
                "position:absolute; top:calc(100% + 4px); right:0; z-index:20; background:#fff; border:1px solid #e6e6e2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:4px; min-width:184px;",
              )}
            >
              <div
                style={css(
                  "font-size:10.5px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.05em; padding:6px 9px 4px;",
                )}
              >
                Move to
              </div>
              {LIFECYCLE_STAGES.map((st) => {
                const active = st.id === current.id;
                return (
                  <Box
                    as="button"
                    role="menuitem"
                    key={st.id}
                    disabled={active}
                    onClick={() => !active && onMove(st.canonical)}
                    style={css(
                      `display:flex; align-items:center; gap:8px; width:100%; padding:7px 9px; border:none; background:none; border-radius:7px; font-size:12.5px; font-family:inherit; color:${active ? "#a3a39d" : "#2a2a28"}; cursor:${active ? "default" : "pointer"}; text-align:left;`,
                    )}
                    hover={css(active ? "" : "background:#f4f4f1;")}
                  >
                    <span
                      style={css(`width:6px; height:6px; border-radius:4px; background:${st.dot};`)}
                    />
                    {st.id}
                    {active && <IconCheck style={css("margin-left:auto; color:#a3a39d;")} />}
                  </Box>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {(email || phone) && (
        <div style={css("display:flex; flex-direction:column; gap:5px;")}>
          {email && (
            <div style={css(INFO_ROW)}>
              <span
                style={css(
                  `width:15px; color:${CH.email.fg}; display:flex; align-items:center; flex:0 0 auto;`,
                )}
                dangerouslySetInnerHTML={{ __html: CH.email.icon }}
              />
              <span style={css(INFO_TEXT)} title={email}>
                {email}
              </span>
            </div>
          )}
          {phone && (
            <div style={css(INFO_ROW)}>
              <span
                style={css(
                  `width:15px; color:${CH.call.fg}; display:flex; align-items:center; flex:0 0 auto;`,
                )}
                dangerouslySetInnerHTML={{ __html: CH.call.icon }}
              />
              <span style={css(INFO_TEXT)} title={phone}>
                {phone}
              </span>
              {li && (
                <span style={css("margin-left:auto; flex:0 0 auto;")}>
                  <LinkedinButton href={li} stopProp={stopProp} />
                </span>
              )}
            </div>
          )}
          {!phone && li && (
            <div style={css(INFO_ROW)}>
              <LinkedinButton href={li} stopProp={stopProp} />
            </div>
          )}
        </div>
      )}

      <div
        style={css(
          "display:flex; align-items:center; gap:7px; padding-top:9px; border-top:1px solid #f4f4f1;",
        )}
      >
        <span
          style={css(
            `width:20px; height:20px; border-radius:6px; background:${ownerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto;`,
          )}
        >
          {ownerInitial}
        </span>
        <span style={css("font-size:12px; color:#75756f; flex:1; min-width:0;")}>
          {contact.owner || "Unassigned"}
        </span>
        <span style={css("display:flex; align-items:center; gap:4px; flex:0 0 auto;")}>
          {contact.loops.map((l, j) => {
            const b = loopBadge(l, true);
            return (
              <span key={j} title={b.title} style={css(b.style)}>
                {b.label}
              </span>
            );
          })}
        </span>
      </div>

      {/* Only a genuinely time-critical follow-up earns a line here. The full
          "needs attention" signal (unassigned, never contacted, no reply) is
          the contacts page queue's job — on a board it fires on nearly every
          card, since nothing backfills historical outreach, and a flag that
          shows on everything is not a flag. */}
      {followUpDue && (
        <div
          style={css(
            "display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:500; color:#c2410c;",
          )}
        >
          <IconWarn size={12} style={css("flex:0 0 auto;")} />
          {followUpDue}
        </div>
      )}
    </Box>
  );
}
