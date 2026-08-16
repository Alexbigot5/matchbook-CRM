// The /templates UI: a template library on the left, the selected template's A/B
// test on the right.
//
// Same shape as sales-loop-crm.tsx — one client component, a useState "God object"
// holding only UI state (selection, drafts, which modal is open) patched through
// patch(), and every write going to the route action through a single useFetcher
// with a hidden `intent`. The template data itself lives in the loader, and React
// Router revalidates it after each write, so there is no optimistic UI.
//
// All the derivation lives in ./ab.ts, which resolves the selection too — that is
// why there is no effect here reconciling a `selectedId` that was deleted or
// filtered away.

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { computeTemplatesView, type TemplateDetailView, type VariantView } from "./ab";
import type { Contact, Viewer } from "./data";
import { Sidebar, buildOwnerTabs, buildViewTabs } from "./sidebar";
import { TEMPLATE_STATUSES, type EmailTemplate, type TemplateStatus } from "./templates";
import { Box, GLOBAL_CSS, IconPlus, IconTrash, MONO, css } from "./ui";
import { LIMITS } from "../lib/validate";

// Mirrors the action's return type in app/routes/templates.tsx.
type ActionResult =
  | { ok: true; message?: string; templateId?: string }
  | { ok: false; error: string };

const CARD = "border:1px solid #ededea; border-radius:11px; background:#fff;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.04em;";
const RAIL_LABEL =
  "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em;";
const GHOST =
  "background:none; border:1px solid #e6e6e2; border-radius:7px; padding:5px 9px; font-size:11.5px; font-family:inherit; color:#575753; cursor:pointer;";
const PRIMARY =
  "background:#1a1a1a; border:1px solid #1a1a1a; border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:500; font-family:inherit; color:#fff; cursor:pointer;";
const WIDE_BTN =
  "width:100%; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #e6e6e2; border-radius:8px; padding:8px; font-size:12.5px; font-weight:500; font-family:inherit; color:#3a3a38; cursor:pointer;";
const INPUT =
  "width:100%; border:1px solid #e6e6e2; border-radius:8px; padding:7px 9px; font-size:12.5px; font-family:inherit; color:#1a1a1a; background:#fff;";
const FIELD_LABEL = "display:block; font-size:11.5px; color:#75756f; margin-bottom:4px;";

const STATUS_WORD: Record<TemplateStatus, string> = {
  draft: "Draft",
  running: "Running",
  concluded: "Concluded",
};

type StatsDraft = { sends: string; opens: string; replies: string; meetings: string };

type State = {
  /** Sidebar VIEWS key — filters the template list by loop. */
  view: string;
  /** Sidebar OWNER key. Held so the rail can render, but templates aren't owned. */
  owner: string;
  selectedId: string | null;
  /** Which variant's copy is open in the inline editor. One at a time. */
  editVariantId: string | null;
  subjectDraft: string;
  bodyDraft: string;
  settingsOpen: boolean;
  nameDraft: string;
  loopDraft: number;
  /** A string so the number input can be transiently empty while being retyped. */
  sendDayDraft: string;
  modal: null | "stats" | "delete" | "removeVariant";
  statsVariantId: string | null;
  statsDraft: StatsDraft;
  pendingRemoveId: string | null;
  actionError: string;
};

const EMPTY_STATS: StatsDraft = { sends: "", opens: "", replies: "", meetings: "" };

export function TemplatesPage({
  contacts,
  templates,
  viewer,
}: {
  contacts: Contact[];
  templates: EmailTemplate[];
  viewer: Viewer;
}) {
  const fetcher = useFetcher();
  const [state, setState] = useState<State>(() => ({
    view: "all",
    owner: "all",
    selectedId: null,
    editVariantId: null,
    subjectDraft: "",
    bodyDraft: "",
    settingsOpen: false,
    nameDraft: "",
    loopDraft: 1,
    sendDayDraft: "0",
    modal: null,
    statsVariantId: null,
    statsDraft: EMPTY_STATS,
    pendingRemoveId: null,
    actionError: "",
  }));
  const S = state;
  const patch = (u: Partial<State>) => setState((s) => ({ ...s, ...u }));

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(fields, { method: "post" });
  const pending = fetcher.state !== "idle";

  // Reconciles only the modal/editor/error UI once a submission settles; the data
  // itself arrives through the revalidated loader.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const result = fetcher.data as ActionResult;
    if (result.ok) {
      patch({
        modal: null,
        actionError: "",
        editVariantId: null,
        settingsOpen: false,
        statsVariantId: null,
        pendingRemoveId: null,
        // Select the template that was just created, rather than guessing which
        // of the revalidated rows is the new one.
        ...(result.templateId ? { selectedId: result.templateId } : {}),
      });
    } else {
      patch({ actionError: result.error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const loopFilter = S.view === "loop1" ? 1 : S.view === "loop2" ? 2 : null;
  const V = computeTemplatesView(templates, S.selectedId, loopFilter);

  // VIEWS reports template counts (it filters templates here); OWNER keeps its
  // contact counts, and says so, because templates have no owner.
  const viewTabs = buildViewTabs(
    contacts,
    S.view,
    (key) => patch({ view: key, actionError: "" }),
    V.counts,
    "All templates",
  );
  const ownerTabs = buildOwnerTabs(contacts, S.owner, (key) => patch({ owner: key }));

  const detail = V.detail;

  const newTemplate = () => submit({ intent: "createTemplate", loop: String(loopFilter ?? 1) });

  const openSettings = (d: TemplateDetailView) =>
    patch({
      settingsOpen: true,
      editVariantId: null,
      actionError: "",
      nameDraft: d.name,
      loopDraft: d.loop,
      sendDayDraft: String(d.sendDay),
    });

  const saveSettings = (d: TemplateDetailView) =>
    submit({
      intent: "updateTemplate",
      id: d.id,
      name: S.nameDraft,
      loop: String(S.loopDraft),
      sendDay: S.sendDayDraft,
    });

  const setStatus = (d: TemplateDetailView, status: string) =>
    submit({ intent: "setTemplateStatus", id: d.id, status });

  const startEdit = (v: VariantView) =>
    patch({
      editVariantId: v.id,
      settingsOpen: false,
      actionError: "",
      subjectDraft: v.subject,
      bodyDraft: v.body,
    });

  const saveCopy = (d: TemplateDetailView, v: VariantView) =>
    submit({
      intent: "saveVariant",
      templateId: d.id,
      variantId: v.id,
      subject: S.subjectDraft,
      body: S.bodyDraft,
    });

  const openStats = (v: VariantView) =>
    patch({
      modal: "stats",
      statsVariantId: v.id,
      actionError: "",
      statsDraft: {
        sends: String(v.sends),
        opens: String(v.opens),
        replies: String(v.replies),
        meetings: String(v.meetings),
      },
    });

  const saveStats = (d: TemplateDetailView) =>
    submit({
      intent: "recordStats",
      templateId: d.id,
      variantId: S.statsVariantId ?? "",
      ...S.statsDraft,
    });

  const closeModal = () => patch({ modal: null, actionError: "" });

  const removeTarget = detail?.variants.find((v) => v.id === S.pendingRemoveId) ?? null;

  return (
    <div
      className="slcrm"
      style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar
        nav="templates"
        viewTabs={viewTabs}
        ownerTabs={ownerTabs}
        viewer={viewer}
        ownerNote="Templates aren’t owned; these counts are contacts."
      />

      <main
        style={css(
          "flex:1; display:flex; flex-direction:column; min-width:0; background:#ffffff;",
        )}
      >
        <div
          style={css(
            "display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #ededea;",
          )}
        >
          <div style={css("min-width:0;")}>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>
              Email templates
            </div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:1px;")}>
              {V.headerSub}
            </div>
          </div>
        </div>

        {S.actionError && (
          <div
            style={css(
              "margin:12px 24px 0; padding:9px 12px; border:1px solid #eddede; background:#fbf3f3; border-radius:9px; font-size:12.5px; color:#9a5b5b;",
            )}
          >
            {S.actionError}
          </div>
        )}

        <div style={css("flex:1; overflow-y:auto; overflow-x:hidden;")}>
          <div
            style={css(
              "display:flex; align-items:flex-start; gap:18px; padding:18px 24px 48px; max-width:1180px;",
            )}
          >
            {/* TEMPLATE LIST */}
            <aside style={css("width:235px; flex:0 0 235px; min-width:0;")}>
              <div
                style={css(
                  "display:flex; align-items:center; justify-content:space-between; padding:0 2px 8px;",
                )}
              >
                <span style={css(RAIL_LABEL)}>Templates</span>
                <Box
                  as="button"
                  onClick={newTemplate}
                  disabled={pending}
                  title="New template"
                  style={css(GHOST + "display:flex; align-items:center; gap:4px;")}
                  hover={css("background:#f4f4f1;")}
                >
                  <IconPlus size={11} />
                  New
                </Box>
              </div>

              {V.cards.length === 0 ? (
                <div
                  style={css(
                    "border:1px dashed #e2e2de; border-radius:11px; padding:16px 14px; text-align:center; font-size:12px; color:#a3a39d;",
                  )}
                >
                  {V.filterEmpty ? "None in this loop" : "No templates yet"}
                </div>
              ) : (
                <div style={css("display:flex; flex-direction:column; gap:6px;")}>
                  {V.cards.map((card) => (
                    <Box
                      as="button"
                      key={card.id}
                      onClick={() =>
                        patch({
                          selectedId: card.id,
                          editVariantId: null,
                          settingsOpen: false,
                          actionError: "",
                        })
                      }
                      style={css(
                        "display:block; width:100%; text-align:left; padding:10px 11px; border-radius:10px; font-family:inherit; cursor:pointer;" +
                          (card.selected
                            ? "background:#fff; border:1px solid #e2e2de; box-shadow:0 1px 3px rgba(0,0,0,0.05);"
                            : "background:#fbfbfa; border:1px solid transparent;"),
                      )}
                      hover={card.selected ? undefined : css("background:#f4f4f1;")}
                    >
                      <span
                        style={css(
                          "display:block; font-size:12.5px; font-weight:500; color:#1a1a1a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                        )}
                      >
                        {card.displayName}
                      </span>
                      <span
                        style={css("display:block; font-size:11.5px; color:#9a9a95; margin-top:2px;")}
                      >
                        {card.metaLine}
                      </span>
                      <span
                        style={css(MONO + "display:block; font-size:11px; color:#a3a39d; margin-top:3px;")}
                      >
                        {card.bestLine}
                      </span>
                    </Box>
                  ))}
                </div>
              )}
            </aside>

            {/* SELECTED TEMPLATE */}
            <section
              style={css("flex:1; min-width:0; display:flex; flex-direction:column; gap:14px;")}
            >
              {!detail ? (
                <div style={css(CARD + "padding:40px 24px; text-align:center;")}>
                  <div style={css("font-size:14px; font-weight:600; color:#1a1a1a;")}>
                    {V.filterEmpty
                      ? `No templates in ${loopFilter === 2 ? "Loop 2" : "Loop 1"}.`
                      : "No email templates yet"}
                  </div>
                  <div
                    style={css(
                      "font-size:12.5px; color:#9a9a95; margin-top:5px; max-width:380px; margin-left:auto; margin-right:auto;",
                    )}
                  >
                    {V.filterEmpty
                      ? "Switch to All templates, or create one on this loop."
                      : "Create a template to write your first cold intro, then add a variant B to test it against."}
                  </div>
                  <div
                    style={css("display:flex; gap:8px; justify-content:center; margin-top:16px;")}
                  >
                    {V.filterEmpty && (
                      <Box
                        as="button"
                        onClick={() => patch({ view: "all" })}
                        style={css(GHOST + "padding:7px 13px; font-size:12.5px;")}
                        hover={css("background:#f4f4f1;")}
                      >
                        Show all templates
                      </Box>
                    )}
                    <Box
                      as="button"
                      onClick={newTemplate}
                      disabled={pending}
                      style={css(PRIMARY)}
                      hover={css("background:#000;")}
                    >
                      New template
                    </Box>
                  </div>
                </div>
              ) : (
                <>
                  <SummaryCard
                    detail={detail}
                    settingsOpen={S.settingsOpen}
                    nameDraft={S.nameDraft}
                    loopDraft={S.loopDraft}
                    sendDayDraft={S.sendDayDraft}
                    pending={pending}
                    onOpenSettings={() => openSettings(detail)}
                    onCancelSettings={() => patch({ settingsOpen: false })}
                    onPatch={patch}
                    onSave={() => saveSettings(detail)}
                    onStatus={(status) => setStatus(detail, status)}
                    onDelete={() => patch({ modal: "delete", actionError: "" })}
                  />

                  {/* No align-items:start — the cards stretch to equal height and
                      each pins its metrics row to the bottom, so the two SENT /
                      OPEN / REPLY / MTGS rows line up even when one variant's
                      copy is longer than the other's. */}
                  <div
                    style={css(
                      "display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:14px;",
                    )}
                  >
                    {detail.variants.map((v) => (
                      <VariantCard
                        key={v.id}
                        variant={v}
                        editing={S.editVariantId === v.id}
                        subjectDraft={S.subjectDraft}
                        bodyDraft={S.bodyDraft}
                        pending={pending}
                        onEdit={() => startEdit(v)}
                        onCancel={() => patch({ editVariantId: null })}
                        onPatch={patch}
                        onSave={() => saveCopy(detail, v)}
                        onPromote={() =>
                          submit({
                            intent: "promoteVariant",
                            templateId: detail.id,
                            variantId: v.id,
                          })
                        }
                        onRecord={() => openStats(v)}
                        onRemove={() =>
                          patch({ modal: "removeVariant", pendingRemoveId: v.id, actionError: "" })
                        }
                      />
                    ))}
                  </div>

                  {detail.canAddVariant && (
                    <Box
                      as="button"
                      onClick={() => submit({ intent: "addVariant", templateId: detail.id })}
                      disabled={pending}
                      style={css(
                        "width:100%; display:flex; align-items:center; justify-content:center; gap:6px; padding:13px; border:1px dashed #e2e2de; border-radius:11px; background:none; font-size:12.5px; font-family:inherit; color:#75756f; cursor:pointer;",
                      )}
                      hover={css("background:#fbfbfa; color:#3a3a38;")}
                    >
                      <IconPlus size={12} />
                      Add variant B to start an A/B test
                    </Box>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </main>

      {/* MODALS */}
      {S.modal && detail && (
        <div
          onClick={closeModal}
          style={css(
            "position:fixed; inset:0; background:rgba(20,20,18,0.22); z-index:60; display:flex; align-items:flex-start; justify-content:center; padding:72px 20px; animation:slcrm-fadeIn 0.14s ease;",
          )}
        >
          <div
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={css(
              "width:440px; max-width:100%; background:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.22); overflow:hidden; animation:slcrm-slideDown 0.18s cubic-bezier(0.2,0.8,0.2,1);",
            )}
          >
            {S.modal === "stats" && (
              <>
                <div style={css("padding:18px 20px 14px; border-bottom:1px solid #ededea;")}>
                  <div style={css("font-size:14px; font-weight:600;")}>Record numbers</div>
                  <div style={css("font-size:11.5px; color:#9a9a95; margin-top:3px;")}>
                    Lifetime totals for this variant, not additions. Your sending tool can push
                    these through the API instead.
                  </div>
                </div>
                <div
                  style={css(
                    "padding:16px 20px; display:grid; grid-template-columns:1fr 1fr; gap:12px;",
                  )}
                >
                  {(["sends", "opens", "replies", "meetings"] as const).map((key) => (
                    <label key={key}>
                      <span style={css(FIELD_LABEL + "text-transform:capitalize;")}>{key}</span>
                      <input
                        type="number"
                        min={0}
                        value={S.statsDraft[key]}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          patch({ statsDraft: { ...S.statsDraft, [key]: e.target.value } })
                        }
                        style={css(INPUT + MONO)}
                      />
                    </label>
                  ))}
                </div>
                <ModalFooter
                  confirmLabel="Save numbers"
                  pending={pending}
                  onCancel={closeModal}
                  onConfirm={() => saveStats(detail)}
                />
              </>
            )}

            {S.modal === "delete" && (
              <>
                <div style={css("padding:18px 20px 14px;")}>
                  <div style={css("font-size:14px; font-weight:600;")}>
                    Delete “{detail.displayName}”?
                  </div>
                  <div
                    style={css("font-size:12.5px; color:#75756f; margin-top:6px; line-height:1.5;")}
                  >
                    This removes the template and all {detail.variants.length} of its variants,
                    including the copy. It can’t be undone, though a record is kept in the audit log.
                  </div>
                </div>
                <ModalFooter
                  confirmLabel="Delete template"
                  destructive
                  pending={pending}
                  onCancel={closeModal}
                  onConfirm={() => submit({ intent: "deleteTemplate", id: detail.id })}
                />
              </>
            )}

            {S.modal === "removeVariant" && (
              <>
                <div style={css("padding:18px 20px 14px;")}>
                  <div style={css("font-size:14px; font-weight:600;")}>
                    Remove variant {removeTarget?.slot ?? "B"}?
                  </div>
                  <div
                    style={css("font-size:12.5px; color:#75756f; margin-top:6px; line-height:1.5;")}
                  >
                    Its copy and its recorded numbers go with it, and the A/B test ends. A record
                    is kept in the audit log.
                  </div>
                </div>
                <ModalFooter
                  confirmLabel="Remove variant"
                  destructive
                  pending={pending}
                  onCancel={closeModal}
                  onConfirm={() =>
                    submit({
                      intent: "removeVariant",
                      templateId: detail.id,
                      variantId: S.pendingRemoveId ?? "",
                    })
                  }
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModalFooter({
  confirmLabel,
  onCancel,
  onConfirm,
  pending,
  destructive,
}: {
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  destructive?: boolean;
}) {
  return (
    <div
      style={css(
        "display:flex; justify-content:flex-end; gap:8px; padding:13px 20px; border-top:1px solid #ededea; background:#fbfbfa;",
      )}
    >
      <Box
        as="button"
        onClick={onCancel}
        style={css(GHOST + "padding:7px 13px; font-size:12.5px;")}
        hover={css("background:#f0f0ec;")}
      >
        Cancel
      </Box>
      <Box
        as="button"
        onClick={onConfirm}
        disabled={pending}
        style={css(
          PRIMARY + (destructive ? "background:#9a5b5b; border-color:#9a5b5b;" : ""),
        )}
        hover={css(destructive ? "background:#8a4f4f;" : "background:#000;")}
      >
        {pending ? "Saving…" : confirmLabel}
      </Box>
    </div>
  );
}

function SummaryCard({
  detail,
  settingsOpen,
  nameDraft,
  loopDraft,
  sendDayDraft,
  pending,
  onOpenSettings,
  onCancelSettings,
  onPatch,
  onSave,
  onStatus,
  onDelete,
}: {
  detail: TemplateDetailView;
  settingsOpen: boolean;
  nameDraft: string;
  loopDraft: number;
  sendDayDraft: string;
  pending: boolean;
  onOpenSettings: () => void;
  onCancelSettings: () => void;
  onPatch: (u: Partial<State>) => void;
  onSave: () => void;
  onStatus: (status: string) => void;
  onDelete: () => void;
}) {
  const { verdict } = detail;
  return (
    <section style={css(CARD + "padding:14px 16px;")}>
      <div style={css("display:flex; align-items:center; gap:9px; flex-wrap:wrap;")}>
        <span style={css("font-size:14.5px; font-weight:600; letter-spacing:-0.01em;")}>
          {detail.displayName}
        </span>
        <span style={css(detail.pill.style)}>{detail.pill.label}</span>

        <span style={css("margin-left:auto; display:flex; align-items:center; gap:6px;")}>
          {/* Status submits immediately, like the contacts page's status menu —
              it is one field, and folding it into the settings editor would mean
              two racing submissions. */}
          <select
            value={detail.status}
            disabled={pending}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onStatus(e.target.value)}
            style={css(GHOST + "padding:5px 7px;")}
          >
            {TEMPLATE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_WORD[s]}
              </option>
            ))}
          </select>
          {!settingsOpen && (
            <Box
              as="button"
              onClick={onOpenSettings}
              style={css(GHOST)}
              hover={css("background:#f4f4f1;")}
            >
              Edit
            </Box>
          )}
          <Box
            as="button"
            onClick={onDelete}
            title="Delete template"
            style={css(GHOST + "display:flex; align-items:center; color:#9a5b5b;")}
            hover={css("background:#fbf3f3;")}
          >
            <IconTrash size={12} />
          </Box>
        </span>
      </div>

      {settingsOpen ? (
        <div
          style={css(
            "margin-top:12px; padding-top:12px; border-top:1px solid #f4f4f1; display:grid; grid-template-columns:minmax(0,2fr) 120px 110px; gap:10px; align-items:end;",
          )}
        >
          <label>
            <span style={css(FIELD_LABEL)}>Name</span>
            <input
              value={nameDraft}
              maxLength={LIMITS.templateName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onPatch({ nameDraft: e.target.value })
              }
              style={css(INPUT)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>Loop</span>
            <select
              value={String(loopDraft)}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                onPatch({ loopDraft: Number(e.target.value) })
              }
              style={css(INPUT)}
            >
              <option value="1">Loop 1</option>
              <option value="2">Loop 2</option>
            </select>
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>Send day</span>
            <input
              type="number"
              min={0}
              value={sendDayDraft}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onPatch({ sendDayDraft: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
          <div style={css("grid-column:1 / -1; display:flex; gap:8px;")}>
            <Box
              as="button"
              onClick={onSave}
              disabled={pending}
              style={css(PRIMARY)}
              hover={css("background:#000;")}
            >
              {pending ? "Saving…" : "Save"}
            </Box>
            <Box
              as="button"
              onClick={onCancelSettings}
              style={css(GHOST + "padding:7px 13px; font-size:12.5px;")}
              hover={css("background:#f4f4f1;")}
            >
              Cancel
            </Box>
          </div>
        </div>
      ) : (
        <>
          <div style={css("font-size:12.5px; color:#9a9a95; margin-top:4px;")}>
            {detail.sendLine}
          </div>
          <div style={css("font-size:13px; color:#3a3a38; margin-top:11px;")}>
            {verdict.headline}
          </div>
          <div
            style={css("font-size:11.5px; color:#a3a39d; margin-top:3px;")}
            title={verdict.caveat || undefined}
          >
            {verdict.detail}
          </div>
        </>
      )}
    </section>
  );
}

function VariantCard({
  variant,
  editing,
  subjectDraft,
  bodyDraft,
  pending,
  onEdit,
  onCancel,
  onPatch,
  onSave,
  onPromote,
  onRecord,
  onRemove,
}: {
  variant: VariantView;
  editing: boolean;
  subjectDraft: string;
  bodyDraft: string;
  pending: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onPatch: (u: Partial<State>) => void;
  onSave: () => void;
  onPromote: () => void;
  onRecord: () => void;
  onRemove: () => void;
}) {
  const v = variant;
  return (
    <div style={css(CARD + "padding:14px 15px; display:flex; flex-direction:column; height:100%;")}>
      <div style={css("display:flex; align-items:center; gap:8px;")}>
        <span
          style={css(
            `width:22px; height:22px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto;` +
              (v.leading ? "background:#1a1a1a; color:#fff;" : "background:#e8e8e4; color:#75756f;"),
          )}
        >
          {v.slot}
        </span>
        <span style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>{v.label}</span>
        {v.isDefault && (
          <span
            style={css(
              "padding:2px 7px; border-radius:6px; background:#f0f0ec; color:#75756f; font-size:11px; font-weight:500;",
            )}
          >
            Default
          </span>
        )}
        {v.leading && (
          <span
            style={css(
              "margin-left:auto; padding:2px 8px; border-radius:6px; background:#e4f3ea; color:#1f7a4d; font-size:11.5px; font-weight:500;",
            )}
          >
            Leading
          </span>
        )}
      </div>

      {editing ? (
        <div style={css("margin-top:12px; display:flex; flex-direction:column; gap:10px;")}>
          <label>
            <span style={css(FIELD_LABEL)}>Subject</span>
            <input
              value={subjectDraft}
              maxLength={LIMITS.subject}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onPatch({ subjectDraft: e.target.value })
              }
              style={css(INPUT)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>
              Body ({"{{first_name}}"}, {"{{company}}"} and {"{{sender}}"} are filled in by your
              sending tool)
            </span>
            <textarea
              value={bodyDraft}
              maxLength={LIMITS.body}
              rows={10}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                onPatch({ bodyDraft: e.target.value })
              }
              style={css(INPUT + "resize:vertical; line-height:1.55;")}
            />
          </label>
          <div style={css("display:flex; gap:8px;")}>
            <Box
              as="button"
              onClick={onSave}
              disabled={pending}
              style={css(PRIMARY)}
              hover={css("background:#000;")}
            >
              {pending ? "Saving…" : "Save copy"}
            </Box>
            <Box
              as="button"
              onClick={onCancel}
              style={css(GHOST + "padding:7px 13px; font-size:12.5px;")}
              hover={css("background:#f4f4f1;")}
            >
              Cancel
            </Box>
          </div>
        </div>
      ) : (
        <>
          <div style={css("margin-top:13px;")}>
            <div style={css(COL_LABEL)}>Subject</div>
            <div
              style={css(
                "font-size:13px; font-weight:600; margin-top:4px;" +
                  (v.subject ? "color:#1a1a1a;" : "color:#c4c4be; font-weight:450;"),
              )}
            >
              {v.subject || v.subjectPlaceholder}
            </div>
          </div>

          <div
            style={css(
              "margin-top:11px; border:1px solid #f0f0ec; background:#fbfbfa; border-radius:9px; padding:11px 12px; font-size:12.5px; line-height:1.6; color:#3a3a38;",
            )}
          >
            {v.bodyParagraphs.length === 0 ? (
              <span style={css("color:#c4c4be;")}>{v.bodyPlaceholder}</span>
            ) : (
              v.bodyParagraphs.map((p, i) => (
                <p
                  key={i}
                  style={css(
                    "margin:0; white-space:pre-wrap;" + (i ? "margin-top:9px;" : ""),
                  )}
                >
                  {p}
                </p>
              ))
            )}
          </div>

          {/* margin-top:auto pins this and everything below it to the card's
              bottom edge, aligning the metrics rows across both variants. */}
          <div
            style={css(
              "display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-top:auto; padding-top:14px;",
            )}
          >
            {v.metrics.map((m) => (
              <div key={m.key} style={css("min-width:0;")}>
                <div style={css(COL_LABEL)}>{m.label}</div>
                <div
                  style={css(
                    MONO + "font-size:15px; font-weight:500; color:#1a1a1a; margin-top:3px;",
                  )}
                >
                  {m.value}
                </div>
              </div>
            ))}
          </div>

          <div
            style={css(
              "height:6px; border-radius:5px; background:#f2f2f0; overflow:hidden; margin-top:12px;",
            )}
          >
            <span
              style={css(
                `display:block; height:100%; border-radius:5px; background:${v.barColor}; width:${v.barWidth};`,
              )}
            />
          </div>

          <div style={css("margin-top:12px; display:flex; flex-direction:column; gap:7px;")}>
            <Box
              as="button"
              onClick={onPromote}
              disabled={pending || !v.canPromote}
              style={css(
                WIDE_BTN + (v.canPromote ? "" : "color:#a3a39d; background:#fbfbfa; cursor:default;"),
              )}
              hover={v.canPromote ? css("background:#f4f4f1;") : undefined}
            >
              {v.promoteLabel}
            </Box>
            <div style={css("display:flex; gap:7px;")}>
              <Box
                as="button"
                onClick={onEdit}
                style={css(GHOST + "flex:1; text-align:center;")}
                hover={css("background:#f4f4f1;")}
              >
                Edit copy
              </Box>
              <Box
                as="button"
                onClick={onRecord}
                style={css(GHOST + "flex:1; text-align:center;")}
                hover={css("background:#f4f4f1;")}
              >
                Record numbers
              </Box>
              {v.canRemove && (
                <Box
                  as="button"
                  onClick={onRemove}
                  style={css(GHOST + "color:#9a5b5b;")}
                  hover={css("background:#fbf3f3;")}
                >
                  Remove
                </Box>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
