// The /smartlead UI.
//
// Same idiom as ./templates-page.tsx: one client component, a `useState` God
// object holding UI state only (patched through `patch()`), a single `useFetcher`
// with a hidden `intent` field, and one `useEffect` folding the action's result
// into a banner. No optimistic UI — React Router revalidates the loader.
//
// Everything numeric on this page arrives precomputed from the loader (step
// lists, eligibility counts, "Jul 20" labels). Nothing here calls `Date`, for the
// usual SSR/hydration reason.

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { CampaignChoice, LoopView, SenderView } from "../routes/smartlead";
import type { Contact, Viewer } from "./data";
import type { SequencePreview, SmartleadSender, WarmupTone } from "./smartlead-map";
import { warmupTone } from "./smartlead-map";
import { Sidebar, buildOwnerTabs, buildViewTabs } from "./sidebar";
import { Box, GLOBAL_CSS, IconClose, IconPencil, IconPlus, IconWarn, MONO, css } from "./ui";
// The client imports the same bounds the action enforces, so the wait box's
// spinner and the copy editor's maxLength stop where the server would refuse —
// the arrangement validate.ts documents for the CSV caps.
import { LIMITS, MAX_STEP_DELAY_DAYS } from "../lib/validate";

// Mirrors the action's return type. Not imported as a value, the same hand-kept
// arrangement templates-page.tsx uses.
type ActionResult =
  | {
      ok: true;
      message?: string;
      campaigns?: CampaignChoice[];
      closed?: "editor";
      senders?: SenderView;
    }
  | { ok: false; error: string };

const CARD =
  "background:#fff; border:1px solid #ededea; border-radius:14px; overflow:hidden;";
const SECTION = "padding:14px 18px; border-top:1px solid #f2f2ef;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em;";
const GHOST =
  "padding:6px 11px; border:1px solid #e2e2dd; background:#fff; border-radius:8px; font-size:12px; color:#3a3a38; cursor:pointer; font-family:inherit;";
const PRIMARY =
  "padding:6px 12px; border:1px solid #1a1a1a; background:#1a1a1a; border-radius:8px; font-size:12px; color:#fff; cursor:pointer; font-family:inherit;";
const INPUT =
  "width:100%; padding:7px 9px; border:1px solid #e2e2dd; border-radius:8px; font-size:12.5px; font-family:inherit; background:#fff; box-sizing:border-box;";
const FIELD_LABEL =
  "display:block; font-size:11px; color:#9a9a95; margin-bottom:4px; font-weight:500;";
const MUTED = "font-size:11.5px; color:#9a9a95;";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Sensible starting point for a cold-email schedule: weekdays, business hours. */
const DEFAULT_SCHEDULE = {
  timezone: "America/New_York",
  days: [1, 2, 3, 4, 5],
  startHour: "09:00",
  endHour: "17:00",
  minGap: "10",
  maxLeadsPerDay: "40",
  startAt: "",
};

type ScheduleDraft = typeof DEFAULT_SCHEDULE;

type State = {
  view: string;
  owner: string;
  actionError: string;
  notice: string;
  /** Campaigns fetched from Smartlead, shared by both loop cards. */
  campaigns: CampaignChoice[];
  /**
   * Mailboxes fetched per loop, or undefined for "not fetched yet".
   *
   * Per loop, not shared like `campaigns`: which mailboxes are assigned is a
   * fact about one campaign. Undefined is a meaningful third state — the loader
   * makes no Smartlead calls, so nothing here is known until the button is
   * pressed, and an empty rotation must not read the same as an unread one.
   */
  senders: Record<number, SenderView | undefined>;
  /** Per-loop picker selection and new-campaign name draft. */
  pick: Record<number, string>;
  newName: Record<number, string>;
  schedule: Record<number, ScheduleDraft>;
  /** Which loop's sequence-upload confirm is open. */
  confirmLoop: number | null;
  /**
   * Sequence-builder UI state, all keyed "<loop>:<step token>" so both cards
   * share one flat map — see stepKey() below.
   */
  expanded: Record<string, boolean>;
  /**
   * In-flight text of a step's wait box. The stored value is the truth and comes
   * from the loader; this only holds what is being typed, until blur posts it.
   * Cleared whenever the fetcher settles, so a revalidated list wins.
   */
  delayDrafts: Record<string, string>;
  /** Per-loop "add a step" selection, as "<templateId>|<slot or all>". */
  addPick: Record<number, string>;
  /** The step being dragged, or null. */
  dragToken: string | null;
  /**
   * The variant whose copy is open in the inline editor, or null.
   *
   * One at a time, and held by variant id rather than by step: the copy lives on
   * the template, so two steps showing the same variant are showing the same
   * text and must not offer two editors over it.
   */
  editing: string | null;
  editSubject: string;
  editBody: string;
};

/**
 * How a step is addressed in UI state and in every builder POST.
 *
 * A step the server derived from send_day has no row and so no id, but it is on
 * screen with the same controls as any other. "#<position>" is its stand-in; the
 * action resolves both forms after materialising the plan (see resolveStepToken
 * in routes/smartlead.tsx).
 */
function stepToken(step: { stepId: string | null; seqNumber: number }): string {
  return step.stepId ?? `#${step.seqNumber}`;
}

const stepKey = (loop: number, token: string) => `${loop}:${token}`;

export function SmartleadPage({
  contacts,
  loops,
  configured,
  maxLeadPush,
  viewer,
}: {
  contacts: Contact[];
  loops: LoopView[];
  configured: boolean;
  maxLeadPush: number;
  viewer: Viewer;
}) {
  const [S, setState] = useState<State>({
    view: "all",
    owner: "all",
    actionError: "",
    notice: "",
    campaigns: [],
    senders: {},
    pick: {},
    newName: {},
    schedule: { 1: { ...DEFAULT_SCHEDULE }, 2: { ...DEFAULT_SCHEDULE } },
    confirmLoop: null,
    expanded: {},
    delayDrafts: {},
    addPick: {},
    dragToken: null,
    editing: null,
    editSubject: "",
    editBody: "",
  });
  const patch = (u: Partial<State>) => setState((s) => ({ ...s, ...u }));

  const fetcher = useFetcher();
  const submit = (fields: Record<string, string>) => fetcher.submit(fields, { method: "post" });
  const pending = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const result = fetcher.data as ActionResult;
    if (result.ok) {
      patch({
        actionError: "",
        notice: result.message ?? "",
        confirmLoop: null,
        // Drafts are discarded on every settled write, not just a successful
        // wait edit: the loader has just revalidated, so the stored value is
        // newer than anything held here — including for a step someone else
        // moved out from under this list.
        delayDrafts: {},
        dragToken: null,
        // Only the save that came FROM the editor closes it. Closing on every
        // successful write would throw away a half-typed body the moment someone
        // pressed an arrow on another row.
        ...(result.closed === "editor" ? { editing: null } : {}),
        // A fetch that returned campaigns replaces the list; every other
        // successful action leaves it alone.
        ...(result.campaigns ? { campaigns: result.campaigns } : {}),
      });
      // Merged, not replaced, and through the functional form: this is one
      // loop's answer, and the other card's list has to survive it.
      const senders = result.senders;
      if (senders) {
        setState((s) => ({ ...s, senders: { ...s.senders, [senders.loop]: senders } }));
      }
    } else {
      patch({ actionError: result.error, notice: "", delayDrafts: {}, dragToken: null });
    }
  }, [fetcher.state, fetcher.data]);

  // The VIEWS rows scope which loop cards are shown. Counts stay over contacts,
  // which is what they genuinely describe here.
  const shown = loops.filter(
    (l) => S.view === "all" || (S.view === "loop1" && l.loop === 1) || (S.view === "loop2" && l.loop === 2),
  );

  const setSchedule = (loop: number, patchDraft: Partial<ScheduleDraft>) =>
    patch({ schedule: { ...S.schedule, [loop]: { ...S.schedule[loop], ...patchDraft } } });

  return (
    <div
      style={css(
        "display:flex; height:100vh; background:#f7f7f5; color:#1c1c1a; font-family:Geist,ui-sans-serif,system-ui,sans-serif; overflow:hidden;",
      )}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar
        nav="smartlead"
        viewTabs={buildViewTabs(contacts, S.view, (key) => patch({ view: key }))}
        ownerTabs={buildOwnerTabs(contacts, S.owner, (key) => patch({ owner: key }))}
        viewer={viewer}
        ownerNote="Campaigns aren’t owned; these are contact counts."
      />

      <div style={css("flex:1; display:flex; flex-direction:column; min-width:0;")}>
        <div
          style={css(
            "display:flex; align-items:center; padding:16px 24px; border-bottom:1px solid #ededea; background:#fff;",
          )}
        >
          <div>
            <div style={css("font-size:15px; font-weight:600; letter-spacing:-0.01em;")}>
              Smartlead
            </div>
            <div style={css(MUTED + "margin-top:2px;")}>
              One campaign per loop: contacts in, copy up, schedule set.
            </div>
          </div>
        </div>

        {!configured && (
          <div
            style={css(
              "margin:12px 24px 0; padding:10px 12px; border:1px solid #ecdfc4; background:#fdf8ee; border-radius:9px; font-size:12.5px; color:#8a6d3b; display:flex; gap:8px; align-items:flex-start;",
            )}
          >
            <IconWarn size={14} style={css("flex:0 0 auto; margin-top:1px;")} />
            <span>
              Smartlead isn’t connected. Set the key and reload; everything below stays
              read-only until then.
              <br />
              <code style={css(MONO + "font-size:11.5px;")}>
                wrangler secret put SMARTLEAD_API_KEY
              </code>
            </span>
          </div>
        )}

        {S.actionError && (
          <div
            style={css(
              "margin:12px 24px 0; padding:9px 12px; border:1px solid #eddede; background:#fbf3f3; border-radius:9px; font-size:12.5px; color:#9a5b5b;",
            )}
          >
            {S.actionError}
          </div>
        )}
        {S.notice && (
          <div
            style={css(
              "margin:12px 24px 0; padding:9px 12px; border:1px solid #dde7dd; background:#f4f8f4; border-radius:9px; font-size:12.5px; color:#4d6b4d;",
            )}
          >
            {S.notice}
          </div>
        )}

        <div style={css("flex:1; overflow-y:auto; padding:16px 24px 40px;")}>
          <div style={css("display:flex; flex-direction:column; gap:16px; max-width:820px;")}>
            {shown.map((loopView) => (
              <LoopCard
                key={loopView.loop}
                view={loopView}
                configured={configured}
                pending={pending}
                maxLeadPush={maxLeadPush}
                campaigns={S.campaigns}
                senders={S.senders[loopView.loop]}
                pick={S.pick[loopView.loop] ?? ""}
                newName={S.newName[loopView.loop] ?? ""}
                schedule={S.schedule[loopView.loop]}
                expanded={S.expanded}
                delayDrafts={S.delayDrafts}
                addPick={S.addPick[loopView.loop] ?? ""}
                dragToken={S.dragToken}
                editing={S.editing}
                editSubject={S.editSubject}
                editBody={S.editBody}
                onPick={(id) => patch({ pick: { ...S.pick, [loopView.loop]: id } })}
                onNewName={(name) => patch({ newName: { ...S.newName, [loopView.loop]: name } })}
                onSchedule={(draft) => setSchedule(loopView.loop, draft)}
                onExpand={(key) =>
                  patch({ expanded: { ...S.expanded, [key]: !S.expanded[key] } })
                }
                onDelayDraft={(key, value) =>
                  patch({ delayDrafts: { ...S.delayDrafts, [key]: value } })
                }
                onAddPick={(value) => patch({ addPick: { ...S.addPick, [loopView.loop]: value } })}
                onDrag={(key) => patch({ dragToken: key })}
                onEdit={(variant) =>
                  patch({
                    editing: variant ? variant.variantId : null,
                    editSubject: variant?.subject ?? "",
                    editBody: variant?.body ?? "",
                    actionError: "",
                  })
                }
                onEditField={(field) => patch(field)}
                onSubmit={submit}
                onConfirmUpload={() => patch({ confirmLoop: loopView.loop, actionError: "", notice: "" })}
              />
            ))}
          </div>
        </div>
      </div>

      {S.confirmLoop !== null && (
        <UploadConfirm
          view={loops.find((l) => l.loop === S.confirmLoop)!}
          pending={pending}
          onCancel={() => patch({ confirmLoop: null })}
          onConfirm={() =>
            submit({ intent: "pushSequence", loop: String(S.confirmLoop) })
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LoopCard({
  view,
  configured,
  pending,
  maxLeadPush,
  campaigns,
  senders,
  pick,
  newName,
  schedule,
  expanded,
  delayDrafts,
  addPick,
  dragToken,
  editing,
  editSubject,
  editBody,
  onPick,
  onNewName,
  onSchedule,
  onExpand,
  onDelayDraft,
  onAddPick,
  onDrag,
  onEdit,
  onEditField,
  onSubmit,
  onConfirmUpload,
}: {
  view: LoopView;
  configured: boolean;
  pending: boolean;
  maxLeadPush: number;
  campaigns: CampaignChoice[];
  senders: SenderView | undefined;
  pick: string;
  newName: string;
  schedule: ScheduleDraft;
  expanded: Record<string, boolean>;
  delayDrafts: Record<string, string>;
  addPick: string;
  dragToken: string | null;
  editing: string | null;
  editSubject: string;
  editBody: string;
  onPick: (id: string) => void;
  onNewName: (name: string) => void;
  onSchedule: (draft: Partial<ScheduleDraft>) => void;
  onExpand: (key: string) => void;
  onDelayDraft: (key: string, value: string) => void;
  onAddPick: (value: string) => void;
  onDrag: (key: string | null) => void;
  onEdit: (variant: SequencePreview | null) => void;
  onEditField: (field: { editSubject?: string; editBody?: string }) => void;
  onSubmit: (fields: Record<string, string>) => void;
  onConfirmUpload: () => void;
}) {
  const { loop, binding, sequence, leads } = view;
  const loopName = loop === 1 ? "always-on outbound" : "event / community blitz";
  const disabled = !configured || pending;
  const post = (fields: Record<string, string>) => onSubmit({ ...fields, loop: String(loop) });

  return (
    <div style={css(CARD)}>
      <div
        style={css(
          "padding:14px 18px; display:flex; align-items:center; justify-content:space-between; gap:12px;",
        )}
      >
        <div>
          <div style={css("font-size:13.5px; font-weight:600;")}>
            Loop {loop}{" "}
            <span style={css("font-weight:450; color:#9a9a95;")}>· {loopName}</span>
          </div>
          <div style={css(MUTED + "margin-top:3px;")}>
            {binding ? (
              <>
                {binding.campaignName || "Untitled campaign"}{" "}
                <span style={css(MONO)}>#{binding.campaignId}</span>
              </>
            ) : (
              "Not linked to a campaign yet."
            )}
          </div>
        </div>
        {binding && (
          <div style={css("display:flex; gap:6px; flex:0 0 auto;")}>
            {(["START", "PAUSED", "STOPPED"] as const).map((status) => (
              <Box
                as="button"
                key={status}
                disabled={disabled}
                onClick={() => post({ intent: "setCampaignStatus", status })}
                style={css(GHOST)}
                hover={css("background:#f4f4f1;")}
              >
                {status === "START" ? "Start" : status === "PAUSED" ? "Pause" : "Stop"}
              </Box>
            ))}
          </div>
        )}
      </div>

      {/* --- Campaign binding ------------------------------------------- */}
      <div style={css(SECTION)}>
        <div style={css(COL_LABEL)}>Campaign</div>
        {binding ? (
          <div style={css("margin-top:8px; display:flex; align-items:center; gap:10px;")}>
            <span style={css(MUTED)}>
              {binding.sequencePushedLabel
                ? `Sequence uploaded ${binding.sequencePushedLabel}.`
                : "Sequence not uploaded yet."}
            </span>
            <Box
              as="button"
              disabled={pending}
              onClick={() => post({ intent: "unlinkCampaign" })}
              style={css(GHOST)}
              hover={css("background:#f4f4f1;")}
            >
              Unlink
            </Box>
          </div>
        ) : (
          <div style={css("margin-top:8px; display:flex; flex-direction:column; gap:10px;")}>
            <div style={css("display:flex; gap:8px; align-items:flex-end;")}>
              <label style={css("flex:1;")}>
                <span style={css(FIELD_LABEL)}>Existing campaign</span>
                <select
                  value={pick}
                  disabled={disabled || !campaigns.length}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onPick(e.target.value)}
                  style={css(INPUT)}
                >
                  <option value="">
                    {campaigns.length ? "Pick a campaign…" : "Fetch campaigns first"}
                  </option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.id}
                      {c.status ? ` · ${c.status}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <Box
                as="button"
                disabled={disabled}
                onClick={() => onSubmit({ intent: "fetchCampaigns" })}
                style={css(GHOST)}
                hover={css("background:#f4f4f1;")}
              >
                Fetch
              </Box>
              <Box
                as="button"
                disabled={disabled || !pick}
                onClick={() => {
                  const chosen = campaigns.find((c) => c.id === pick);
                  if (!chosen) return;
                  post({ intent: "linkCampaign", campaignId: chosen.id, campaignName: chosen.name });
                }}
                style={css(PRIMARY)}
                hover={css("background:#333;")}
              >
                Link
              </Box>
            </div>
            <div style={css("display:flex; gap:8px; align-items:flex-end;")}>
              <label style={css("flex:1;")}>
                <span style={css(FIELD_LABEL)}>…or create a new one</span>
                <input
                  value={newName}
                  maxLength={120}
                  placeholder={`Loop ${loop} outbound`}
                  disabled={disabled}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNewName(e.target.value)}
                  style={css(INPUT)}
                />
              </label>
              <Box
                as="button"
                disabled={disabled || !newName.trim()}
                onClick={() => post({ intent: "createCampaign", name: newName.trim() })}
                style={css(GHOST)}
                hover={css("background:#f4f4f1;")}
              >
                Create
              </Box>
            </div>
          </div>
        )}
      </div>

      {/* --- Senders ------------------------------------------------------ */}
      {binding && (
        <Senders
          loop={loop}
          // Re-linked to a different campaign since the fetch? Then this list is
          // about a campaign that is no longer on this card — back to unread.
          senders={senders?.campaignId === binding.campaignId ? senders : undefined}
          disabled={disabled}
          onPost={post}
        />
      )}

      {/* --- Sequence ---------------------------------------------------- */}
      <SequenceBuilder
        loop={loop}
        sequence={sequence}
        disabled={disabled}
        canUpload={Boolean(binding)}
        expanded={expanded}
        delayDrafts={delayDrafts}
        addPick={addPick}
        dragToken={dragToken}
        editing={editing}
        editSubject={editSubject}
        editBody={editBody}
        onExpand={onExpand}
        onDelayDraft={onDelayDraft}
        onAddPick={onAddPick}
        onDrag={onDrag}
        onEdit={onEdit}
        onEditField={onEditField}
        onPost={post}
        onConfirmUpload={onConfirmUpload}
      />

      {/* --- Contacts ---------------------------------------------------- */}
      <div style={css(SECTION)}>
        <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
          <div style={css(COL_LABEL)}>Contacts</div>
          <div style={css("display:flex; gap:6px;")}>
            <Box
              as="button"
              disabled={disabled || !binding}
              onClick={() => post({ intent: "importLeads" })}
              style={css(GHOST)}
              hover={css("background:#f4f4f1;")}
            >
              Import leads
            </Box>
            <Box
              as="button"
              disabled={disabled || !binding || !leads.eligible}
              onClick={() => post({ intent: "pushContacts" })}
              style={css(PRIMARY)}
              hover={css("background:#333;")}
            >
              Push {leads.eligible}
            </Box>
          </div>
        </div>
        <div style={css("margin-top:8px; display:flex; flex-wrap:wrap; gap:6px 14px;")}>
          <Stat label="on this loop" value={leads.onLoop} />
          <Stat label="ready to push" value={leads.eligible} />
          <Stat label="already in campaign" value={leads.alreadyPushed} />
          <Stat label="emailed so far" value={leads.emailed} />
          {leads.noEmail > 0 && <Stat label="no email" value={leads.noEmail} />}
          {leads.inOtherCampaign > 0 && (
            <Stat label={`in Loop ${loop === 1 ? 2 : 1}'s campaign`} value={leads.inOtherCampaign} />
          )}
          {Object.entries(leads.wrongStatus).map(([status, count]) => (
            <Stat key={status} label={status.toLowerCase()} value={count} />
          ))}
        </div>
        {leads.eligible > maxLeadPush && (
          <div style={css(MUTED + "margin-top:7px;")}>
            Pushes {maxLeadPush} at a time. Press again to continue.
          </div>
        )}
        {leads.inOtherCampaign > 0 && (
          <div style={css(MUTED + "margin-top:7px;")}>
            Contacts in both loops are held back so they aren’t emailed by two campaigns
            at once.
          </div>
        )}
        {binding && leads.alreadyPushed > leads.emailed && (
          <div style={css(MUTED + "margin-top:7px;")}>
            “Emailed so far” counts what Smartlead has confirmed sending, and only
            updates when you sync below. Pushing a contact queues it; the campaign
            decides when it goes out.
          </div>
        )}
      </div>

      {/* --- Schedule ---------------------------------------------------- */}
      <div style={css(SECTION)}>
        <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
          <div style={css(COL_LABEL)}>Sending schedule</div>
          <Box
            as="button"
            disabled={disabled || !binding}
            onClick={() =>
              post({
                intent: "saveSchedule",
                timezone: schedule.timezone,
                days: JSON.stringify(schedule.days),
                startHour: schedule.startHour,
                endHour: schedule.endHour,
                minGap: schedule.minGap,
                maxLeadsPerDay: schedule.maxLeadsPerDay,
                startAt: schedule.startAt,
              })
            }
            style={css(GHOST)}
            hover={css("background:#f4f4f1;")}
          >
            Save schedule
          </Box>
        </div>

        <div style={css("margin-top:9px; display:flex; gap:5px; flex-wrap:wrap;")}>
          {DAY_NAMES.map((name, index) => {
            const on = schedule.days.includes(index);
            return (
              <Box
                as="button"
                key={name}
                disabled={disabled}
                onClick={() =>
                  onSchedule({
                    days: on
                      ? schedule.days.filter((d) => d !== index)
                      : [...schedule.days, index].sort((a, b) => a - b),
                  })
                }
                style={css(
                  GHOST +
                    (on ? "background:#1a1a1a; border-color:#1a1a1a; color:#fff;" : ""),
                )}
                hover={css(on ? "background:#333;" : "background:#f4f4f1;")}
              >
                {name}
              </Box>
            );
          })}
        </div>

        <div
          style={css(
            "margin-top:10px; display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px;",
          )}
        >
          <label>
            <span style={css(FIELD_LABEL)}>Timezone</span>
            <input
              value={schedule.timezone}
              maxLength={60}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onSchedule({ timezone: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>From</span>
            <input
              type="time"
              value={schedule.startHour}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onSchedule({ startHour: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>Until</span>
            <input
              type="time"
              value={schedule.endHour}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onSchedule({ endHour: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>Min gap (mins)</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={schedule.minGap}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onSchedule({ minGap: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
          <label>
            <span style={css(FIELD_LABEL)}>New leads / day</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={schedule.maxLeadsPerDay}
              disabled={disabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onSchedule({ maxLeadsPerDay: e.target.value })
              }
              style={css(INPUT + MONO)}
            />
          </label>
        </div>
      </div>

      {/* --- Results ----------------------------------------------------- */}
      <div style={css(SECTION)}>
        <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
          <div style={css(COL_LABEL)}>Results</div>
          <Box
            as="button"
            disabled={disabled || !binding}
            onClick={() => post({ intent: "syncStats" })}
            style={css(GHOST)}
            hover={css("background:#f4f4f1;")}
          >
            Sync stats
          </Box>
        </div>
        <div style={css(MUTED + "margin-top:8px;")}>
          {binding?.statsSyncedLabel
            ? `Last synced ${binding.statsSyncedLabel}.`
            : "Never synced."}{" "}
          Numbers land on each template’s variant counters over on Templates, and every
          send is logged as an email touchpoint on the contact it went to — moving anyone
          still marked New to Contacted.
        </div>
        {binding?.lastResult && (
          <div style={css(MUTED + "margin-top:5px;")}>{binding.lastResult}</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span style={css("font-size:12px; color:#575753;")}>
      <span style={css(MONO + "font-weight:500; color:#1a1a1a;")}>{value}</span> {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

const SENDER_ROW =
  "display:flex; align-items:center; gap:9px; font-size:12.5px; padding:7px 9px; background:#fafaf8; border-radius:8px;";
const SENDER_CHIP =
  "flex:0 0 auto; font-size:10.5px; padding:2px 6px; border-radius:5px; background:#eeeee9; color:#575753;";

/**
 * The warmup dot's colour, by band.
 *
 * The band is this CRM's reading of Smartlead's percentage, not a grade
 * Smartlead publishes — see warmupTone(). The figure itself is always printed
 * beside the dot, so the colour never has to be taken on trust.
 */
const WARMUP_DOT: Record<WarmupTone, string> = {
  strong: "#6f8f6f",
  fair: "#c1a05a",
  weak: "#b57070",
  unknown: "#c4c4be",
};

/**
 * Which mailboxes this loop's campaign sends from.
 *
 * Rendered only once a campaign is linked, and empty until "Fetch senders" is
 * pressed: the loader deliberately makes no Smartlead calls (see the route), so
 * an assignment made in Smartlead's own dashboard five minutes ago is invisible
 * here until someone asks for it. That is why the caption distinguishes "not
 * loaded" from "none assigned" rather than showing an empty list for both.
 *
 * Assigning and unassigning are the whole scope. Buying or connecting a mailbox
 * happens in Smartlead, the same way the campaign and the templates do.
 */
function Senders({
  loop,
  senders,
  disabled,
  onPost,
}: {
  loop: number;
  senders: SenderView | undefined;
  disabled: boolean;
  onPost: (fields: Record<string, string>) => void;
}) {
  const assigned = senders?.assigned ?? [];
  const available = senders?.available ?? [];

  return (
    <div style={css(SECTION)}>
      <div style={css("display:flex; align-items:center; justify-content:space-between; gap:8px;")}>
        <div style={css(COL_LABEL)}>Senders</div>
        <Box
          as="button"
          disabled={disabled}
          onClick={() => onPost({ intent: "fetchSenders" })}
          style={css(GHOST)}
          hover={css("background:#f4f4f1;")}
        >
          Fetch senders
        </Box>
      </div>

      {assigned.length > 0 && (
        <div style={css("margin-top:9px; display:flex; flex-direction:column; gap:5px;")}>
          {assigned.map((sender) => (
            <SenderRow key={sender.accountId} sender={sender}>
              <Box
                as="button"
                disabled={disabled}
                title={`Take ${sender.fromEmail || "this mailbox"} out of the rotation`}
                onClick={() =>
                  onPost({ intent: "removeSender", accountId: sender.accountId })
                }
                style={css(ICON_BTN)}
                hover={css("background:#eeeee9; color:#9a5b5b;")}
              >
                <IconClose size={12} />
              </Box>
            </SenderRow>
          ))}
        </div>
      )}

      {senders && available.length > 0 && (
        <>
          <div style={css(COL_LABEL + "margin-top:12px;")}>
            On the account, not on this campaign
          </div>
          <div
            style={css(
              "margin-top:6px; display:flex; flex-direction:column; gap:5px; max-height:220px; overflow-y:auto;",
            )}
          >
            {available.map((sender) => (
              <SenderRow key={sender.accountId} sender={sender}>
                <Box
                  as="button"
                  disabled={disabled}
                  onClick={() =>
                    onPost({ intent: "assignSender", accountId: sender.accountId })
                  }
                  style={css(PRIMARY + "flex:0 0 auto; padding:4px 10px;")}
                  hover={css("background:#333;")}
                >
                  Assign
                </Box>
              </SenderRow>
            ))}
          </div>
        </>
      )}

      <div style={css(MUTED + "margin-top:8px;")}>
        {!senders ? (
          <>
            Not loaded. Press “Fetch senders” to read this campaign’s mailboxes from
            Smartlead — none of it is stored here, so nothing is asked for until you ask.
          </>
        ) : (
          <>
            {assigned.length
              ? `${assigned.length} mailbox${assigned.length === 1 ? "" : "es"} rotating.`
              : "No mailboxes assigned, so this campaign can’t send."}{" "}
            Warmup health is pulled from Smartlead, not tracked separately here.
          </>
        )}
      </div>

      {senders && !available.length && (
        <div style={css(MUTED + "margin-top:5px;")}>
          Every mailbox on this Smartlead account is already on this campaign. Connect
          more in Smartlead.
        </div>
      )}
    </div>
  );
}

/** One mailbox: warmup dot, address, provider, and whatever control the list needs. */
function SenderRow({
  sender,
  children,
}: {
  sender: SmartleadSender;
  children: React.ReactNode;
}) {
  const tone = warmupTone(sender);
  return (
    <div style={css(SENDER_ROW)}>
      <span
        title={
          sender.warmupReputation
            ? `Warmup reputation ${sender.warmupReputation}, as Smartlead reports it`
            : "Smartlead reports no warmup reputation for this mailbox"
        }
        style={css(
          `flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:${WARMUP_DOT[tone]};`,
        )}
      />
      <span
        style={css(
          "flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
        )}
      >
        {sender.fromEmail || <span style={css(MUTED)}>No address</span>}
        {sender.fromName && <span style={css(MUTED)}> · {sender.fromName}</span>}
      </span>
      {sender.provider && <span style={css(SENDER_CHIP)}>{sender.provider}</span>}
      {/* The figure verbatim, never rounded into a word of ours — the dot is the
          only interpretation on this row, and it is documented as one. */}
      <span style={css(MUTED + "flex:0 0 auto;")}>
        {sender.warmupReputation
          ? `warmup ${sender.warmupReputation}`
          : "warmup not reported"}
        {sender.warmupReputation && !sender.warmupEnabled ? " · off" : ""}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sequence builder
// ---------------------------------------------------------------------------

const STEP_ROW =
  "display:flex; align-items:center; gap:9px; font-size:12.5px; padding:7px 9px; background:#fafaf8; border-radius:8px; border:1px solid transparent;";
const ICON_BTN =
  "border:none; background:none; padding:2px 4px; border-radius:5px; color:#b0b0aa; cursor:pointer; font-family:inherit; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center;";
const SLOT_CHIP =
  "flex:0 0 auto; font-size:10.5px; padding:2px 6px; border-radius:5px; border:1px solid transparent; font-family:inherit;";

/** The chip colours: a pinned variant is neutral, an A/B split is the amber one. */
function slotChipStyle(split: boolean): string {
  return (
    SLOT_CHIP +
    (split
      ? "background:#efe7d6; color:#8a6d3b;"
      : "background:#eeeee9; color:#575753;")
  );
}

/**
 * One variant's copy under an expanded step: read it, or edit it in place.
 *
 * The editor writes to `template_variants` through the same saveVariant() the
 * Templates page uses — there is one copy of this text and this is a second door
 * onto it, not a second store. That is worth saying on screen, which the caption
 * does: an operator fixing a typo mid-campaign is entitled to know they are
 * editing the template every other step and page shows.
 *
 * Saving does NOT reach Smartlead. The campaign keeps sending the old text until
 * the sequence is uploaded again, and the action's message says so.
 */
function StepCopy({
  variant,
  showSlot,
  disabled,
  editing,
  subject,
  body,
  onEdit,
  onField,
  onSave,
}: {
  variant: SequencePreview;
  showSlot: boolean;
  disabled: boolean;
  editing: boolean;
  subject: string;
  body: string;
  onEdit: (variant: SequencePreview | null) => void;
  onField: (field: { editSubject?: string; editBody?: string }) => void;
  onSave: () => void;
}) {
  if (!editing) {
    return (
      <div>
        <div style={css("display:flex; align-items:flex-start; justify-content:space-between; gap:10px;")}>
          <div style={css(COL_LABEL)}>Subject{showSlot ? ` · ${variant.slot}` : ""}</div>
          <Box
            as="button"
            disabled={disabled}
            onClick={() => onEdit(variant)}
            style={css(GHOST + "flex:0 0 auto; display:flex; align-items:center; gap:5px; padding:4px 9px;")}
            hover={css("background:#f4f4f1;")}
          >
            <IconPencil size={12} /> Edit
          </Box>
        </div>
        <div style={css("font-size:12.5px; font-weight:500; margin-top:3px;")}>
          {variant.subject || <span style={css(MUTED)}>No subject</span>}
        </div>
        <div style={css(COL_LABEL + "margin-top:8px;")}>Body</div>
        <div
          style={css(
            "margin-top:3px; padding:9px 11px; background:#fff; border:1px solid #ededea; border-radius:8px; font-size:12.5px; line-height:1.55; white-space:pre-wrap; max-height:220px; overflow-y:auto;",
          )}
        >
          {variant.body || <span style={css(MUTED)}>No body written yet.</span>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={css(COL_LABEL)}>Subject{showSlot ? ` · ${variant.slot}` : ""}</div>
      <input
        value={subject}
        maxLength={LIMITS.subject}
        disabled={disabled}
        autoFocus
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          onField({ editSubject: e.target.value })
        }
        style={css(INPUT + "margin-top:3px;")}
      />
      <div style={css(COL_LABEL + "margin-top:8px;")}>Body</div>
      <textarea
        value={body}
        maxLength={LIMITS.body}
        disabled={disabled}
        rows={10}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
          onField({ editBody: e.target.value })
        }
        style={css(
          INPUT + "margin-top:3px; line-height:1.55; resize:vertical; min-height:120px;",
        )}
      />
      <div
        style={css(
          "margin-top:8px; display:flex; align-items:center; justify-content:space-between; gap:10px;",
        )}
      >
        <span style={css(MUTED)}>
          Saves to the template, so Templates and any other step using it show the same copy.
        </span>
        <span style={css("display:flex; gap:8px; flex:0 0 auto;")}>
          <Box
            as="button"
            disabled={disabled}
            onClick={() => onEdit(null)}
            style={css(GHOST)}
            hover={css("background:#f4f4f1;")}
          >
            Cancel
          </Box>
          <Box
            as="button"
            disabled={disabled}
            onClick={onSave}
            style={css(PRIMARY)}
            hover={css("background:#333;")}
          >
            Save
          </Box>
        </span>
      </div>
    </div>
  );
}

/**
 * The step list, and everything that edits it.
 *
 * Every control posts and waits — no optimistic reordering — which is the same
 * bargain the rest of the CRM makes (see the module header). It matters more
 * here than elsewhere: the stored order is what a later stats sync attributes
 * Smartlead's numbers by, so a list showing an arrangement the server hasn't
 * accepted would be showing a lie about where the next numbers will land.
 *
 * The one piece of local state is the wait box's text, because a number input
 * that round-trips per keystroke can't be typed in. It posts on blur, and the
 * draft is dropped as soon as any write settles.
 */
function SequenceBuilder({
  loop,
  sequence,
  disabled,
  canUpload,
  expanded,
  delayDrafts,
  addPick,
  dragToken,
  editing,
  editSubject,
  editBody,
  onExpand,
  onDelayDraft,
  onAddPick,
  onDrag,
  onEdit,
  onEditField,
  onPost,
  onConfirmUpload,
}: {
  loop: number;
  sequence: LoopView["sequence"];
  disabled: boolean;
  canUpload: boolean;
  expanded: Record<string, boolean>;
  delayDrafts: Record<string, string>;
  addPick: string;
  dragToken: string | null;
  editing: string | null;
  editSubject: string;
  editBody: string;
  onExpand: (key: string) => void;
  onDelayDraft: (key: string, value: string) => void;
  onAddPick: (value: string) => void;
  onDrag: (key: string | null) => void;
  onEdit: (variant: SequencePreview | null) => void;
  onEditField: (field: { editSubject?: string; editBody?: string }) => void;
  onPost: (fields: Record<string, string>) => void;
  onConfirmUpload: () => void;
}) {
  const steps = sequence.included;
  const tokens = steps.map(stepToken);

  /** Post the whole list in its new order — see reorderSequenceSteps. */
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= tokens.length || from === to) return;
    const next = [...tokens];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onPost({ intent: "reorderSteps", ids: JSON.stringify(next) });
  };

  return (
    <div style={css(SECTION)}>
      <div style={css("display:flex; align-items:center; justify-content:space-between; gap:8px;")}>
        <div style={css(COL_LABEL)}>Sequence</div>
        <div style={css("display:flex; gap:6px;")}>
          {sequence.custom && (
            <Box
              as="button"
              disabled={disabled}
              title="Discard this arrangement and follow the templates' send days again"
              onClick={() => onPost({ intent: "resetSteps" })}
              style={css(GHOST)}
              hover={css("background:#f4f4f1;")}
            >
              Reset to template order
            </Box>
          )}
          <Box
            as="button"
            disabled={disabled || !canUpload || sequence.problems.length > 0}
            onClick={onConfirmUpload}
            style={css(GHOST)}
            hover={css("background:#f4f4f1;")}
          >
            Upload sequence
          </Box>
        </div>
      </div>

      {steps.length > 0 && (
        <div style={css("margin-top:9px; display:flex; flex-direction:column; gap:5px;")}>
          {steps.map((step, index) => {
            const token = tokens[index];
            const key = stepKey(loop, token);
            const open = Boolean(expanded[key]);
            const split = step.variantCount > 1;
            const dragging = dragToken === key;
            const post = (fields: Record<string, string>) =>
              onPost({ ...fields, stepId: token });

            return (
              <div
                key={key}
                // Native HTML5 drag, no library — the same choice lifecycle-page.tsx
                // documents. It is pointer-only, which is why the ↑/↓ buttons stay:
                // they are the keyboard path to a move, not a redundant convenience.
                draggable={!disabled}
                onDragStart={() => onDrag(key)}
                onDragEnd={() => onDrag(null)}
                onDragOver={(e: React.DragEvent) => e.preventDefault()}
                onDrop={(e: React.DragEvent) => {
                  e.preventDefault();
                  const from = tokens.findIndex((t) => stepKey(loop, t) === dragToken);
                  if (from >= 0) reorder(from, index);
                  onDrag(null);
                }}
                style={css(
                  "background:#fafaf8; border-radius:8px; border:1px solid " +
                    (dragging ? "#d8d8d2;" : "transparent;") +
                    (dragging ? "opacity:0.55;" : ""),
                )}
              >
                <div style={css(STEP_ROW + "border:none; background:none; padding:7px 9px;")}>
                  <span
                    title="Drag to reorder"
                    style={css(
                      MONO + "flex:0 0 auto; color:#c4c4be; cursor:grab; font-size:12px;",
                    )}
                  >
                    ⠿
                  </span>
                  <span style={css(MONO + "flex:0 0 14px; color:#9a9a95; font-size:11px;")}>
                    {step.seqNumber}
                  </span>

                  {/* The variant chip is a control, not a label, whenever the
                      template has copy in more than one slot: pinning to A or B
                      is how the same template appears twice sending different
                      copy. With one usable slot there is nothing to choose. */}
                  {step.usableSlots.length > 1 ? (
                    <select
                      value={step.variantSlot ?? "all"}
                      disabled={disabled}
                      title="Which variant this step sends"
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                        post({ intent: "setStepVariant", slot: e.target.value })
                      }
                      style={css(slotChipStyle(split) + "cursor:pointer;")}
                    >
                      <option value="all">A/B</option>
                      {step.usableSlots.map((slot) => (
                        <option key={slot} value={slot}>
                          {slot}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={css(slotChipStyle(false))}>{step.slots[0]}</span>
                  )}

                  <Box
                    as="button"
                    onClick={() => onExpand(key)}
                    title={open ? "Hide the copy" : "Show the copy"}
                    style={css(
                      "flex:1; min-width:0; text-align:left; border:none; background:none; padding:0; cursor:pointer; font-family:inherit; color:inherit;",
                    )}
                    hover={css("color:#000;")}
                  >
                    <span
                      style={css(
                        "display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px;",
                      )}
                    >
                      {step.name}
                    </span>
                    <span
                      style={css(
                        MUTED +
                          "display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                      )}
                    >
                      {step.preview[0]?.subject || "No subject"}
                    </span>
                  </Box>

                  {/* Step one has no wait to set: Smartlead starts the sequence
                      when the lead enters it, so a delay there postpones the whole
                      campaign. buildSequencePlan forces it to 0 regardless. */}
                  {index === 0 ? (
                    <span style={css(MUTED + "flex:0 0 auto;")}>sends first</span>
                  ) : (
                    <span
                      style={css("flex:0 0 auto; display:flex; align-items:center; gap:5px;")}
                    >
                      <input
                        type="number"
                        min={0}
                        max={MAX_STEP_DELAY_DAYS}
                        value={delayDrafts[key] ?? String(step.delayDays)}
                        disabled={disabled}
                        title="Days to wait after the previous step"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          onDelayDraft(key, e.target.value)
                        }
                        onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                          const value = e.target.value.trim();
                          if (!value || Number(value) === step.delayDays) return;
                          post({ intent: "setStepDelay", delayDays: value });
                        }}
                        style={css(
                          INPUT + "width:56px; padding:4px 6px; font-size:12px; text-align:right;",
                        )}
                      />
                      <span style={css(MUTED)}>d wait</span>
                    </span>
                  )}

                  <span style={css(MONO + "flex:0 0 46px; text-align:right; color:#9a9a95; font-size:11px;")}>
                    Day {step.dayOffset}
                  </span>

                  <span style={css("flex:0 0 auto; display:flex; gap:1px;")}>
                    <Box
                      as="button"
                      disabled={disabled || index === 0}
                      title="Move up"
                      onClick={() => reorder(index, index - 1)}
                      style={css(ICON_BTN)}
                      hover={css("background:#eeeee9; color:#575753;")}
                    >
                      ↑
                    </Box>
                    <Box
                      as="button"
                      disabled={disabled || index === steps.length - 1}
                      title="Move down"
                      onClick={() => reorder(index, index + 1)}
                      style={css(ICON_BTN)}
                      hover={css("background:#eeeee9; color:#575753;")}
                    >
                      ↓
                    </Box>
                    {/* The last step can't be removed: an empty table means
                        "derive from send_day", so emptying it would restore every
                        template rather than nothing. The action refuses it too. */}
                    <Box
                      as="button"
                      disabled={disabled || steps.length === 1}
                      title={
                        steps.length === 1
                          ? "A sequence needs at least one step"
                          : "Remove this step"
                      }
                      onClick={() => post({ intent: "removeStep" })}
                      style={css(ICON_BTN)}
                      hover={css("background:#eeeee9; color:#9a5b5b;")}
                    >
                      <IconClose size={12} />
                    </Box>
                  </span>
                </div>

                {open && (
                  <div style={css("padding:0 9px 10px 44px; display:flex; flex-direction:column; gap:10px;")}>
                    {step.preview.map((variant) => (
                      <StepCopy
                        key={variant.variantId}
                        variant={variant}
                        showSlot={split}
                        disabled={disabled}
                        editing={editing === variant.variantId}
                        subject={editSubject}
                        body={editBody}
                        onEdit={onEdit}
                        onField={onEditField}
                        onSave={() =>
                          onPost({
                            intent: "saveVariant",
                            templateId: step.templateId,
                            variantId: variant.variantId,
                            subject: editSubject,
                            body: editBody,
                          })
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* --- Add a step ------------------------------------------------- */}
      <div style={css("margin-top:9px; display:flex; gap:8px; align-items:center;")}>
        <select
          value={addPick}
          disabled={disabled || !sequence.addable.length}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onAddPick(e.target.value)}
          style={css(INPUT + "flex:1;")}
        >
          <option value="">
            {sequence.addable.length
              ? "Choose a template…"
              : `No templates on Loop ${loop} yet. Write one on Templates`}
          </option>
          {sequence.addable.map((template) => (
            // One entry per usable variant plus, for an A/B template, a combined
            // one. Offering the split as its own choice is what keeps a two-variant
            // template uploadable as Smartlead's own A/B test — which is the
            // pre-existing behaviour, and the only shape the /templates verdict is
            // computed from.
            <optgroup key={template.id} label={`${template.name} · day ${template.sendDay}`}>
              {template.usableSlots.length > 1 && (
                <option value={`${template.id}|all`}>
                  {template.name} · A/B split
                </option>
              )}
              {template.usableSlots.map((slot) => (
                <option key={slot} value={`${template.id}|${slot}`}>
                  {template.name} · variant {slot}
                </option>
              ))}
              {!template.usableSlots.length && (
                <option value="" disabled>
                  {template.name} (no copy written yet)
                </option>
              )}
            </optgroup>
          ))}
        </select>
        <Box
          as="button"
          disabled={disabled || !addPick}
          onClick={() => {
            const [templateId, slot] = addPick.split("|");
            if (!templateId || !slot) return;
            onPost({ intent: "addStep", templateId, slot });
            onAddPick("");
          }}
          style={css(GHOST + "flex:0 0 auto; display:flex; align-items:center; gap:5px;")}
          hover={css("background:#f4f4f1;")}
        >
          <IconPlus size={13} /> Add step
        </Box>
      </div>

      <div style={css(MUTED + "margin-top:8px;")}>
        {steps.length
          ? `${steps.length} step${steps.length === 1 ? "" : "s"} over ${sequence.totalDays} day${
              sequence.totalDays === 1 ? "" : "s"
            }. Uploading replaces the campaign's existing steps.`
          : "No steps yet. Add one below, or write a template on Templates."}
        {steps.length > 0 && !sequence.custom && (
          <>
            {" "}
            Following the templates’ send days. Reorder or edit a step and this loop keeps
            its own arrangement from then on.
          </>
        )}
      </div>

      {sequence.skipped.map((s) => (
        <div key={`${s.templateId}:${s.reason}`} style={css(MUTED + "margin-top:6px;")}>
          Skipped “{s.name}”: {s.reason}.
        </div>
      ))}
      {sequence.warnings.map((w) => (
        <div key={w} style={css("margin-top:7px; font-size:12px; color:#8a6d3b;")}>
          {w}
        </div>
      ))}
      {sequence.problems.map((p) => (
        <div key={p} style={css("margin-top:7px; font-size:12px; color:#9a5b5b;")}>
          {p}
        </div>
      ))}
    </div>
  );
}

/**
 * The upload confirm.
 *
 * It spells out that the push REPLACES the campaign's steps rather than adding
 * to them — that is Smartlead's actual semantics, and it will silently discard
 * anything written by hand over there.
 */
function UploadConfirm({
  view,
  pending,
  onCancel,
  onConfirm,
}: {
  view: LoopView;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = view.sequence.stepCount;
  return (
    <div
      onClick={onCancel}
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
        <div style={css("padding:18px 20px 14px; border-bottom:1px solid #ededea;")}>
          <div style={css("font-size:14px; font-weight:600;")}>
            Upload {count} step{count === 1 ? "" : "s"} to Loop {view.loop}?
          </div>
          <div style={css(MUTED + "margin-top:6px; line-height:1.5;")}>
            This <strong>replaces every step</strong> in the Smartlead campaign, including
            anything written there by hand. If the campaign is running it will be paused
            for the edit and left paused, so you can check it before sending resumes.
          </div>
        </div>
        <div
          style={css(
            "padding:12px 20px; display:flex; justify-content:flex-end; gap:8px; background:#fafaf8;",
          )}
        >
          <Box
            as="button"
            onClick={onCancel}
            disabled={pending}
            style={css(GHOST)}
            hover={css("background:#f0f0ec;")}
          >
            Cancel
          </Box>
          <Box
            as="button"
            onClick={onConfirm}
            disabled={pending}
            style={css(PRIMARY)}
            hover={css("background:#333;")}
          >
            {pending ? "Uploading…" : "Replace sequence"}
          </Box>
        </div>
      </div>
    </div>
  );
}
