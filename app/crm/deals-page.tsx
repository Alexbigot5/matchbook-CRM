// The /deals view: every deal as a card, in a column per pipeline stage.
//
// Same idiom as lifecycle-page.tsx — one client component, a `useState` God
// object holding only UI state, and a single `useFetcher` that posts intents to
// this route's action. No optimistic UI: React Router revalidates the loader
// after each write, so `deals` (a prop) is the truth.
//
// WHAT MAKES THIS BOARD DIFFERENT FROM /lifecycle. That board's columns are a
// projection of `contacts.status`, so moving a card rewrites a person's
// engagement marker. These columns are the stored `deals.stage`, a separate axis
// (see migrations/0018), so moving a card here changes the DEAL and touches no
// contact's status at all. The two boards can and will disagree — a deal at
// Negotiation whose champion still reads "Contacted" is a real, visible state,
// which is why the stakeholder mini-cards show the contact's own status pill.
//
// SCROLLING and DRAG-AND-DROP follow lifecycle-page.tsx exactly, for the reasons
// its header states: the whole board is ONE scroll container (a per-column
// overflow-y clips each card's ⋮ popover), and the ⋮ "Move to" menu is the
// keyboard path to every move, not a convenience — native HTML5 drag is
// pointer-only. Don't remove it as redundant.

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  computeDealBoard,
  type Contact,
  type Deal,
  DEAL_STAGES,
  dealStageMeta,
  dealValueLabel,
  type DealRole,
  type DealStakeholder,
  ownerAvatar,
  statusMeta,
  type StatusMeta,
  type Viewer,
} from "./data";
import { buildOwnerTabs, buildViewTabs, Sidebar } from "./sidebar";
import {
  Box,
  css,
  GLOBAL_CSS,
  IconChevronDown,
  IconClose,
  IconPlus,
  IconSearch,
  MONO,
} from "./ui";
import { LIMITS } from "../lib/validate";

type StakeholderTarget = { dealId: string; role: DealRole };

type State = {
  view: string;
  owner: string;
  /** Deal whose ⋮ "Move to" menu is open. */
  menuId: string | null;
  /** Card currently being dragged; null outside a drag. */
  draggingId: string | null;
  /** Stage the pointer is over during a drag; drives the drop highlight. */
  dragOverStage: string | null;
  /** "newDeal" | "stakeholder" | null. */
  modal: string | null;
  /** Which deal + slot the stakeholder picker is filling. */
  picking: StakeholderTarget | null;
  pickSearch: string;
  form: { companyName: string; stage: string; value: string; expectedCloseDate: string };
  actionError: string;
};

type ActionResult = { ok: true; message?: string; dealId?: string } | { ok: false; error: string };

const EMPTY_FORM = { companyName: "", stage: DEAL_STAGES[0].id, value: "", expectedCloseDate: "" };

const CARD =
  "border:1px solid #ededea; border-radius:12px; background:#fff; padding:12px 13px; display:flex; flex-direction:column; gap:10px;";
const FIELD =
  "width:100%; padding:9px 11px; border:1px solid #e6e6e2; border-radius:9px; font-size:13px; font-family:inherit; color:#1a1a1a; background:#fff;";
const FIELD_LABEL =
  "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px; display:block;";

/**
 * A stakeholder mini-card: who they are, and their OWN engagement status.
 *
 * The status pill is the contact's `status`, never the deal's stage. Showing the
 * stage here would be showing the same fact twice (the card is already in that
 * column) and would hide the one thing worth seeing — that the deal has moved on
 * and the person has not.
 */
function StakeholderCard({
  stakeholder,
  onRemove,
  stopProp,
}: {
  stakeholder: DealStakeholder;
  onRemove: () => void;
  stopProp: (e: any) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const avatar = ownerAvatar(stakeholder.owner);
  const sm = statusMeta(stakeholder.status);
  const isPrimary = stakeholder.role === "primary";
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={css(
        `position:relative; display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:9px; background:${isPrimary ? "#fbfbfa" : "#fdfdfc"}; border:1px solid ${isPrimary ? "#ededea" : "#f2f2f0"}; min-width:0;`,
      )}
    >
      <span
        style={css(
          `width:22px; height:22px; border-radius:6px; background:${avatar.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto;`,
        )}
      >
        {avatar.initial}
      </span>
      <span style={css("flex:1; min-width:0;")}>
        <span
          style={css(
            "display:block; font-size:12.5px; font-weight:500; color:#2a2a28; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
          )}
          title={stakeholder.name}
        >
          {stakeholder.name}
        </span>
        <span
          style={css(
            `display:block; font-size:10.5px; color:#a3a39d; margin-top:1px; text-transform:uppercase; letter-spacing:0.04em;`,
          )}
        >
          {stakeholder.role}
        </span>
      </span>
      {/* Hidden while the ✕ takes its place rather than shifted — the same rule
          SidebarRow's count follows. */}
      <span
        style={css(
          `display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:6px; font-size:10.5px; font-weight:500; background:${sm.bg}; color:${sm.fg}; white-space:nowrap; flex:0 0 auto; visibility:${hovered ? "hidden" : "visible"};`,
        )}
        title={`Contact status: ${stakeholder.status}`}
      >
        <span style={css(`width:5px; height:5px; border-radius:3px; background:${sm.dot};`)} />
        {stakeholder.status}
      </span>
      {hovered && (
        <Box
          as="button"
          onClick={(e: any) => {
            stopProp(e);
            onRemove();
          }}
          title={`Remove ${stakeholder.name} from this deal`}
          style={css(
            "position:absolute; top:50%; right:6px; transform:translateY(-50%); border:none; background:none; padding:3px; border-radius:6px; display:flex; align-items:center; justify-content:center; color:#a3a39d; cursor:pointer; font-family:inherit;",
          )}
          hover={css("background:#e6e6e2; color:#9a5b5b;")}
        >
          <IconClose size={13} />
        </Box>
      )}
    </div>
  );
}

/** The dashed affordance shown for whichever of the two slots is still open. */
function EmptySlot({
  role,
  onClick,
  stopProp,
}: {
  role: DealRole;
  onClick: () => void;
  stopProp: (e: any) => void;
}) {
  return (
    <Box
      as="button"
      onClick={(e: any) => {
        stopProp(e);
        onClick();
      }}
      style={css(
        "display:flex; align-items:center; gap:7px; width:100%; padding:7px 9px; border:1px dashed #e2e2df; border-radius:9px; background:none; font-size:12px; color:#a3a39d; cursor:pointer; font-family:inherit; text-align:left;",
      )}
      hover={css("border-color:#c8c8c3; color:#575753; background:#fbfbfa;")}
    >
      <IconPlus size={13} />
      {role === "primary" ? "Add a stakeholder" : "Add a second stakeholder"}
    </Box>
  );
}

function DealCard({
  deal,
  dragging,
  menuOpen,
  onToggleMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onAddStakeholder,
  onRemoveStakeholder,
  stopProp,
}: {
  deal: Deal;
  dragging: boolean;
  menuOpen: boolean;
  onToggleMenu: (e: any) => void;
  onMove: (stage: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onAddStakeholder: (role: DealRole) => void;
  onRemoveStakeholder: (contactId: string) => void;
  stopProp: (e: any) => void;
}) {
  const value = dealValueLabel(deal.value);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={css(CARD + `cursor:grab; opacity:${dragging ? "0.45" : "1"};`)}
    >
      <div style={css("display:flex; align-items:flex-start; gap:8px; min-width:0;")}>
        <div style={css("flex:1; min-width:0;")}>
          <div
            style={css(
              "font-size:13.5px; font-weight:600; color:#1a1a1a; letter-spacing:-0.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
            )}
            title={deal.companyName}
          >
            {deal.companyName}
          </div>
          <div
            style={css(
              "display:flex; align-items:center; gap:7px; margin-top:3px; flex-wrap:wrap;",
            )}
          >
            {value && (
              <span style={css(MONO + "font-size:12px; color:#3a3a38; font-weight:500;")}>
                {value}
              </span>
            )}
            {deal.expectedCloseLabel && (
              <span style={css("font-size:11.5px; color:#a3a39d;")}>
                {value ? "· " : ""}
                closes {deal.expectedCloseLabel}
              </span>
            )}
            {!value && !deal.expectedCloseLabel && (
              <span style={css("font-size:11.5px; color:#c0c0ba;")}>Not priced yet</span>
            )}
          </div>
        </div>
        {/* The accessible path to every move this board can make. DnD is
            pointer-only; see the module header. */}
        <div style={css("position:relative; flex:0 0 auto;")}>
          <Box
            as="button"
            onClick={onToggleMenu}
            title="Move to stage"
            style={css(
              "border:none; background:none; padding:3px 5px; border-radius:6px; color:#a3a39d; cursor:pointer; font-family:inherit; display:flex; align-items:center;",
            )}
            hover={css("background:#f0f0ec; color:#575753;")}
          >
            <IconChevronDown />
          </Box>
          {menuOpen && (
            <div
              onClick={stopProp}
              style={css(
                "position:absolute; top:calc(100% + 4px); right:0; z-index:20; background:#fff; border:1px solid #e6e6e2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:4px; min-width:160px;",
              )}
            >
              <div
                style={css(
                  "font-size:10.5px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; padding:6px 9px 4px;",
                )}
              >
                Move to
              </div>
              {DEAL_STAGES.map((stage) => (
                <Box
                  as="button"
                  key={stage.id}
                  onClick={() => onMove(stage.id)}
                  style={css(
                    `display:flex; align-items:center; gap:8px; width:100%; padding:7px 9px; border:none; background:${stage.id === deal.stage ? "#f4f4f1" : "none"}; border-radius:7px; font-size:12.5px; color:#3a3a38; cursor:pointer; font-family:inherit; text-align:left;`,
                  )}
                  hover={css("background:#f4f4f1;")}
                >
                  <span
                    style={css(`width:6px; height:6px; border-radius:4px; background:${stage.dot};`)}
                  />
                  {stage.id}
                </Box>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* At most two, by construction — see migrations/0018. */}
      <div style={css("display:flex; flex-direction:column; gap:6px;")}>
        {deal.primary ? (
          <StakeholderCard
            stakeholder={deal.primary}
            onRemove={() => onRemoveStakeholder(deal.primary!.contactId)}
            stopProp={stopProp}
          />
        ) : (
          <EmptySlot role="primary" onClick={() => onAddStakeholder("primary")} stopProp={stopProp} />
        )}
        {deal.secondary ? (
          <StakeholderCard
            stakeholder={deal.secondary}
            onRemove={() => onRemoveStakeholder(deal.secondary!.contactId)}
            stopProp={stopProp}
          />
        ) : (
          <EmptySlot
            role="secondary"
            onClick={() => onAddStakeholder("secondary")}
            stopProp={stopProp}
          />
        )}
      </div>
    </div>
  );
}

export function DealsPage({
  deals,
  contacts,
  viewer,
}: {
  deals: Deal[];
  contacts: Contact[];
  viewer: Viewer;
}) {
  const fetcher = useFetcher();
  const [state, setState] = useState<State>(() => ({
    view: "all",
    owner: "all",
    menuId: null,
    draggingId: null,
    dragOverStage: null,
    modal: null,
    picking: null,
    pickSearch: "",
    form: { ...EMPTY_FORM },
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
      patch({ modal: null, picking: null, pickSearch: "", form: { ...EMPTY_FORM }, actionError: "" });
    } else {
      patch({ actionError: result.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // ---- handlers ----
  const stopProp = (e: any) => e.stopPropagation();
  const toggleMenu = (id: string, e?: any) => {
    if (e) e.stopPropagation();
    patch((s) => ({ menuId: s.menuId === id ? null : id }));
  };

  const setStage = (dealId: string, stage: string) => {
    patch({ menuId: null, actionError: "" });
    submit({ intent: "setDealStage", dealId, stage });
  };

  const createDeal = () => {
    patch({ actionError: "" });
    submit({
      intent: "createDeal",
      companyName: S.form.companyName,
      stage: S.form.stage,
      value: S.form.value,
      expectedCloseDate: S.form.expectedCloseDate,
    });
  };

  const addStakeholder = (contactId: string) => {
    if (!S.picking) return;
    patch({ actionError: "" });
    submit({
      intent: "addStakeholder",
      dealId: S.picking.dealId,
      contactId,
      role: S.picking.role,
    });
  };

  const removeStakeholder = (dealId: string, contactId: string) => {
    patch({ actionError: "" });
    submit({ intent: "removeStakeholder", dealId, contactId });
  };

  const onDragStart = (id: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    patch({ draggingId: id, menuId: null });
  };
  const onDragEnd = () => patch({ draggingId: null, dragOverStage: null });

  // No onDragLeave: it fires on every child boundary crossing, which makes the
  // highlight flicker. Each column's onDragOver sets the stage (last one wins)
  // and only drop/dragend clear it.
  const onDragOver = (stage: StatusMeta) => (e: React.DragEvent) => {
    e.preventDefault(); // without this the drop event never fires
    e.dataTransfer.dropEffect = "move";
    if (S.dragOverStage !== stage.id) patch({ dragOverStage: stage.id });
  };

  const onDrop = (stage: StatusMeta) => (e: React.DragEvent) => {
    e.preventDefault();
    // dataTransfer first: it is only readable during `drop`, and preferring it
    // means a stray text drag from another app yields a string that matches no
    // deal rather than moving whatever was last dragged.
    const id = e.dataTransfer.getData("text/plain") || S.draggingId || "";
    patch({ draggingId: null, dragOverStage: null });
    const d = deals.find((x) => x.id === id);
    if (!d) return;
    // Dropping onto the column the card already occupies is a no-op — the same
    // guard lifecycle-page.tsx applies, here to avoid a pointless write and a
    // spurious closed_at rewrite.
    if (d.stage === stage.id) return;
    setStage(d.id, stage.id);
  };

  // ---- derived ----
  // Loops belong to CONTACTS, not deals, so a deal is in Loop N when one of its
  // stakeholders is. Without this the rail's VIEWS rows would be inert here, and
  // an unexplained control that does nothing when clicked is what generates bug
  // reports (the same problem /templates solves with `ownerNote`).
  const loopsByContact = new Map(contacts.map((c) => [c.id, c.loops]));
  const dealLoops = (d: Deal): number[] => {
    const out = new Set<number>();
    for (const s of [d.primary, d.secondary]) {
      if (!s) continue;
      for (const l of loopsByContact.get(s.contactId) ?? []) out.add(l);
    }
    return [...out];
  };
  const dealOwners = (d: Deal): (string | null)[] =>
    [d.primary, d.secondary].filter((s) => s !== null).map((s) => s!.owner);

  const byView = (d: Deal) =>
    S.view === "all" ? true : dealLoops(d).includes(S.view === "loop1" ? 1 : 2);
  const byOwner = (d: Deal) => {
    if (S.owner === "all") return true;
    const owners = dealOwners(d);
    // A deal with no stakeholder at all has no owner to match, so it shows only
    // under "Everyone" — it is genuinely unassigned, not Tom's and not Britton's.
    if (S.owner === "unassigned") return owners.length === 0 || owners.some((o) => !o);
    return owners.includes(S.owner);
  };

  // Rail counts are over the unfiltered list; the board is over the filtered one.
  const viewTabs = buildViewTabs(
    contacts,
    S.view,
    (key) => patch({ view: key, menuId: null }),
    {
      all: deals.length,
      loop1: deals.filter((d) => dealLoops(d).includes(1)).length,
      loop2: deals.filter((d) => dealLoops(d).includes(2)).length,
    },
    "All deals",
  );
  const ownerTabs = buildOwnerTabs(contacts, S.owner, (key) =>
    patch({ owner: key, menuId: null }),
  ).map((tab) => ({
    ...tab,
    // Same override reason as viewTabs: these rows filter DEALS on this page, so
    // reporting contact counts beside them would be saying something untrue.
    count:
      tab.key === "all"
        ? deals.length
        : tab.key === "unassigned"
          ? deals.filter((d) => {
              const owners = dealOwners(d);
              return owners.length === 0 || owners.some((o) => !o);
            }).length
          : deals.filter((d) => dealOwners(d).includes(tab.key)).length,
  }));

  const scoped = deals.filter((d) => byView(d) && byOwner(d));
  const board = computeDealBoard(scoped);

  // Contacts eligible for the slot being filled: everyone not already on that
  // deal. Filtering the two current stakeholders out is what stops the picker
  // offering a choice that addContactToDeal is guaranteed to refuse.
  const pickingDeal = S.picking ? deals.find((d) => d.id === S.picking!.dealId) ?? null : null;
  const taken = new Set(
    pickingDeal
      ? [pickingDeal.primary?.contactId, pickingDeal.secondary?.contactId].filter(Boolean)
      : [],
  );
  const search = S.pickSearch.trim().toLowerCase();
  const pickable = contacts
    .filter((c) => !taken.has(c.id))
    .filter((c) =>
      !search
        ? true
        : c.name.toLowerCase().includes(search) || c.company.toLowerCase().includes(search),
    )
    // The people already at this company first — on a deal for Halcyon Labs, the
    // Halcyon Labs contacts are the answer, and scrolling past 400 others to find
    // them is the difference between the picker working and not.
    .sort((a, b) => {
      const at = pickingDeal && a.companyId && a.companyId === pickingDeal.companyId ? 0 : 1;
      const bt = pickingDeal && b.companyId && b.companyId === pickingDeal.companyId ? 0 : 1;
      return at - bt;
    })
    .slice(0, 200);

  const pending = fetcher.state !== "idle";
  const scope = [
    S.view === "loop1" ? "Loop 1" : S.view === "loop2" ? "Loop 2" : "",
    S.owner === "all" ? "" : S.owner === "unassigned" ? "unassigned" : S.owner,
  ].filter(Boolean);
  const totalValue = dealValueLabel(board.value);
  const headerSub =
    `${board.total} deal${board.total === 1 ? "" : "s"} across ${DEAL_STAGES.length} stages` +
    (board.value ? ` · ${totalValue} in pipeline` : "") +
    (scope.length ? ` · ${scope.join(" · ")}` : "");

  return (
    <div
      className="slcrm"
      style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar nav="deals" viewTabs={viewTabs} ownerTabs={ownerTabs} viewer={viewer} />

      <main
        style={css("flex:1; display:flex; flex-direction:column; min-width:0; background:#ffffff;")}
      >
        <div
          style={css(
            "display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #ededea;",
          )}
        >
          <div style={css("min-width:0; flex:1;")}>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>Deals</div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:1px;")}>{headerSub}</div>
          </div>
          <Box
            as="button"
            onClick={() => patch({ modal: "newDeal", actionError: "", form: { ...EMPTY_FORM } })}
            style={css(
              "display:flex; align-items:center; gap:7px; border:none; background:#1a1a1a; color:#fff; padding:9px 14px; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:pointer; flex:0 0 auto;",
            )}
            hover={css("background:#333;")}
          >
            <IconPlus />
            New deal
          </Box>
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

        {/* The board's single scroll container — see the module header. */}
        <div
          style={css("flex:1; overflow:auto;")}
          onClick={() => S.menuId && patch({ menuId: null })}
        >
          {board.total === 0 ? (
            <div style={css("padding:56px 24px; text-align:center; font-size:13px; color:#a3a39d;")}>
              {deals.length === 0
                ? "No deals yet. Create one with “New deal”."
                : "No deals match these filters."}
            </div>
          ) : (
            <div
              style={css("display:flex; align-items:flex-start; gap:14px; padding:18px 24px 48px;")}
            >
              {board.columns.map((col) => {
                const isOver = S.dragOverStage === col.stage.id;
                const colValue = dealValueLabel(col.value);
                return (
                  <section
                    key={col.stage.id}
                    onDragOver={onDragOver(col.stage)}
                    onDrop={onDrop(col.stage)}
                    style={css(
                      `flex:0 0 304px; width:304px; border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:10px; background:${isOver ? col.stage.bg : "#fcfcfb"}; border:1px solid ${isOver ? col.stage.dot : "#ededea"}; transition:background 0.12s ease, border-color 0.12s ease;`,
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
                        {colValue ? `${colValue} in this stage` : "Nothing priced yet"}
                      </div>
                    </header>

                    {col.count === 0 ? (
                      <div
                        style={css(
                          "padding:18px 10px; text-align:center; font-size:11.5px; color:#c0c0ba; border:1px dashed #e6e6e2; border-radius:11px;",
                        )}
                      >
                        {isOver ? "Drop to move here" : "No deals here"}
                      </div>
                    ) : (
                      col.deals.map((d) => (
                        <DealCard
                          key={d.id}
                          deal={d}
                          dragging={S.draggingId === d.id}
                          menuOpen={S.menuId === d.id}
                          onToggleMenu={(e) => toggleMenu(d.id, e)}
                          onMove={(stage) => setStage(d.id, stage)}
                          onDragStart={onDragStart(d.id)}
                          onDragEnd={onDragEnd}
                          onAddStakeholder={(role) =>
                            patch({
                              modal: "stakeholder",
                              picking: { dealId: d.id, role },
                              pickSearch: "",
                              actionError: "",
                            })
                          }
                          onRemoveStakeholder={(contactId) => removeStakeholder(d.id, contactId)}
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

      {/* MODALS — the overlay shell stays per-page, as it already is between
          sales-loop-crm.tsx and templates-page.tsx. */}
      {S.modal && (
        <>
          <div
            onClick={() => patch({ modal: null, picking: null, actionError: "" })}
            style={css(
              "position:fixed; inset:0; background:rgba(20,20,18,0.18); z-index:60; animation:slcrm-fadeIn 0.15s ease;",
            )}
          />
          <div
            style={css(
              "position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:440px; max-width:92vw; max-height:86vh; background:#fff; z-index:61; border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.18); display:flex; flex-direction:column; overflow:hidden; animation:slcrm-slideDown 0.18s cubic-bezier(0.2,0.8,0.2,1);",
            )}
          >
            {S.modal === "newDeal" && (
              <>
                <div
                  style={css(
                    "padding:20px 22px 16px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;",
                  )}
                >
                  <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>
                    New deal
                  </div>
                  <Box
                    as="button"
                    onClick={() => patch({ modal: null, actionError: "" })}
                    style={css(
                      "border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;",
                    )}
                    hover={css("background:#e8e8e4;")}
                  >
                    <IconClose size={15} />
                  </Box>
                </div>
                <div
                  style={css(
                    "padding:18px 22px 22px; display:flex; flex-direction:column; gap:14px; overflow-y:auto;",
                  )}
                >
                  <div>
                    <label style={css(FIELD_LABEL)}>Company</label>
                    <input
                      autoFocus
                      value={S.form.companyName}
                      maxLength={LIMITS.company}
                      placeholder="Halcyon Labs"
                      onChange={(e) =>
                        patch((s) => ({ form: { ...s.form, companyName: e.target.value } }))
                      }
                      style={css(FIELD)}
                    />
                    {/* Says the quiet part out loud: this field is matched, not
                        just stored. Without it, "why did my new company merge
                        with an existing one" is a mystery. */}
                    <div style={css("font-size:11px; color:#a3a39d; margin-top:5px; line-height:1.45;")}>
                      Matched to an existing company ignoring case and spacing. A different
                      spelling — “Halcyon Labs Inc” — is a different company.
                    </div>
                  </div>
                  <div>
                    <label style={css(FIELD_LABEL)}>Stage</label>
                    <select
                      value={S.form.stage}
                      onChange={(e) => patch((s) => ({ form: { ...s.form, stage: e.target.value } }))}
                      style={css(FIELD + "cursor:pointer;")}
                    >
                      {DEAL_STAGES.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={css("display:flex; gap:12px;")}>
                    <div style={css("flex:1; min-width:0;")}>
                      <label style={css(FIELD_LABEL)}>Value</label>
                      <input
                        value={S.form.value}
                        inputMode="numeric"
                        placeholder="Optional"
                        onChange={(e) =>
                          patch((s) => ({ form: { ...s.form, value: e.target.value } }))
                        }
                        style={css(FIELD)}
                      />
                    </div>
                    <div style={css("flex:1; min-width:0;")}>
                      <label style={css(FIELD_LABEL)}>Expected close</label>
                      <input
                        type="date"
                        value={S.form.expectedCloseDate}
                        onChange={(e) =>
                          patch((s) => ({ form: { ...s.form, expectedCloseDate: e.target.value } }))
                        }
                        style={css(FIELD)}
                      />
                    </div>
                  </div>
                  {S.actionError && (
                    <div style={css("font-size:12px; color:#c2410c;")}>{S.actionError}</div>
                  )}
                  <div
                    style={css("display:flex; justify-content:flex-end; gap:8px; margin-top:2px;")}
                  >
                    <Box
                      as="button"
                      onClick={() => patch({ modal: null, actionError: "" })}
                      style={css(
                        "border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;",
                      )}
                      hover={css("background:#f4f4f1;")}
                    >
                      Cancel
                    </Box>
                    <Box
                      as="button"
                      onClick={createDeal}
                      disabled={pending || !S.form.companyName.trim()}
                      style={css(
                        `border:none; background:#1a1a1a; color:#fff; padding:9px 16px; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:${pending || !S.form.companyName.trim() ? "default" : "pointer"}; opacity:${pending || !S.form.companyName.trim() ? "0.5" : "1"};`,
                      )}
                      hover={css(pending || !S.form.companyName.trim() ? "" : "background:#333;")}
                    >
                      {pending ? "Creating…" : "Create deal"}
                    </Box>
                  </div>
                </div>
              </>
            )}

            {S.modal === "stakeholder" && (
              <>
                <div
                  style={css(
                    "padding:20px 22px 14px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;",
                  )}
                >
                  <div style={css("min-width:0;")}>
                    <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>
                      Add {S.picking?.role === "secondary" ? "a second" : "a"} stakeholder
                    </div>
                    {pickingDeal && (
                      <div style={css("font-size:12px; color:#9a9a95; margin-top:2px;")}>
                        {pickingDeal.companyName} · {S.picking?.role}
                      </div>
                    )}
                  </div>
                  <Box
                    as="button"
                    onClick={() => patch({ modal: null, picking: null, actionError: "" })}
                    style={css(
                      "border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66; flex:0 0 auto;",
                    )}
                    hover={css("background:#e8e8e4;")}
                  >
                    <IconClose size={15} />
                  </Box>
                </div>
                <div style={css("padding:14px 22px 0;")}>
                  <div style={css("position:relative;")}>
                    <span
                      style={css(
                        "position:absolute; left:11px; top:50%; transform:translateY(-50%); color:#a3a39d; display:flex;",
                      )}
                    >
                      <IconSearch />
                    </span>
                    <input
                      autoFocus
                      value={S.pickSearch}
                      placeholder="Search contacts"
                      onChange={(e) => patch({ pickSearch: e.target.value })}
                      style={css(FIELD + "padding-left:32px;")}
                    />
                  </div>
                  {S.actionError && (
                    <div style={css("font-size:12px; color:#c2410c; margin-top:10px;")}>
                      {S.actionError}
                    </div>
                  )}
                </div>
                <div style={css("flex:1; overflow-y:auto; padding:12px 22px 22px; min-height:0;")}>
                  {pickable.length === 0 ? (
                    <div
                      style={css("padding:28px 10px; text-align:center; font-size:12.5px; color:#a3a39d;")}
                    >
                      No contacts match.
                    </div>
                  ) : (
                    <div
                      style={css(
                        "border:1px solid #ededea; border-radius:11px; overflow:hidden; background:#fff;",
                      )}
                    >
                      {pickable.map((c, j) => {
                        const avatar = ownerAvatar(c.owner);
                        const sameCompany =
                          !!pickingDeal && !!c.companyId && c.companyId === pickingDeal.companyId;
                        return (
                          <Box
                            as="button"
                            key={c.id}
                            onClick={() => addStakeholder(c.id)}
                            disabled={pending}
                            style={css(
                              `display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; border:none; background:none; cursor:${pending ? "default" : "pointer"}; font-family:inherit; text-align:left; ${j > 0 ? "border-top:1px solid #f2f2f0;" : ""}`,
                            )}
                            hover={css(pending ? "" : "background:#faf9f6;")}
                          >
                            <span
                              style={css(
                                `width:26px; height:26px; border-radius:7px; background:${avatar.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto;`,
                              )}
                            >
                              {avatar.initial}
                            </span>
                            <span style={css("flex:1; min-width:0;")}>
                              <span
                                style={css(
                                  "display:block; font-size:13px; font-weight:500; color:#2a2a28; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                                )}
                              >
                                {c.name}
                              </span>
                              {c.company && (
                                <span
                                  style={css(
                                    "display:block; font-size:11.5px; color:#9a9a95; margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                                  )}
                                >
                                  {c.company}
                                </span>
                              )}
                            </span>
                            {sameCompany && (
                              <span
                                style={css(
                                  "font-size:10.5px; font-weight:500; color:#1f7a4d; background:#e4f3ea; padding:2px 7px; border-radius:6px; white-space:nowrap; flex:0 0 auto;",
                                )}
                              >
                                At this company
                              </span>
                            )}
                          </Box>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
