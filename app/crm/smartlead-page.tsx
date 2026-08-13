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
import type { CampaignChoice, LoopView } from "../routes/smartlead";
import type { Contact, Viewer } from "./data";
import { Sidebar, buildOwnerTabs, buildViewTabs } from "./sidebar";
import { Box, GLOBAL_CSS, IconWarn, MONO, css } from "./ui";

// Mirrors the action's return type. Not imported as a value, the same hand-kept
// arrangement templates-page.tsx uses.
type ActionResult =
  | { ok: true; message?: string; campaigns?: CampaignChoice[] }
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
  /** Per-loop picker selection and new-campaign name draft. */
  pick: Record<number, string>;
  newName: Record<number, string>;
  schedule: Record<number, ScheduleDraft>;
  /** Which loop's sequence-upload confirm is open. */
  confirmLoop: number | null;
};

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
    pick: {},
    newName: {},
    schedule: { 1: { ...DEFAULT_SCHEDULE }, 2: { ...DEFAULT_SCHEDULE } },
    confirmLoop: null,
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
        // A fetch that returned campaigns replaces the list; every other
        // successful action leaves it alone.
        ...(result.campaigns ? { campaigns: result.campaigns } : {}),
      });
    } else {
      patch({ actionError: result.error, notice: "" });
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
        ownerNote="Campaigns aren’t owned — these are contact counts."
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
              One campaign per loop — contacts in, copy up, schedule set.
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
              Smartlead isn’t connected. Set the key and reload — everything below stays
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
                pick={S.pick[loopView.loop] ?? ""}
                newName={S.newName[loopView.loop] ?? ""}
                schedule={S.schedule[loopView.loop]}
                onPick={(id) => patch({ pick: { ...S.pick, [loopView.loop]: id } })}
                onNewName={(name) => patch({ newName: { ...S.newName, [loopView.loop]: name } })}
                onSchedule={(draft) => setSchedule(loopView.loop, draft)}
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
  pick,
  newName,
  schedule,
  onPick,
  onNewName,
  onSchedule,
  onSubmit,
  onConfirmUpload,
}: {
  view: LoopView;
  configured: boolean;
  pending: boolean;
  maxLeadPush: number;
  campaigns: CampaignChoice[];
  pick: string;
  newName: string;
  schedule: ScheduleDraft;
  onPick: (id: string) => void;
  onNewName: (name: string) => void;
  onSchedule: (draft: Partial<ScheduleDraft>) => void;
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

      {/* --- Sequence ---------------------------------------------------- */}
      <div style={css(SECTION)}>
        <div style={css("display:flex; align-items:center; justify-content:space-between;")}>
          <div style={css(COL_LABEL)}>Sequence</div>
          <Box
            as="button"
            disabled={disabled || !binding || sequence.problems.length > 0}
            onClick={onConfirmUpload}
            style={css(GHOST)}
            hover={css("background:#f4f4f1;")}
          >
            Upload sequence
          </Box>
        </div>

        {sequence.included.length > 0 && (
          <div style={css("margin-top:9px; display:flex; flex-direction:column; gap:5px;")}>
            {sequence.included.map((step) => (
              <div
                key={step.templateId}
                style={css(
                  "display:flex; align-items:center; gap:9px; font-size:12.5px; padding:5px 8px; background:#fafaf8; border-radius:7px;",
                )}
              >
                <span style={css(MONO + "color:#9a9a95; flex:0 0 54px;")}>
                  Day {step.sendDay}
                </span>
                <span style={css("flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")}>
                  {step.name}
                </span>
                {step.variantCount > 1 && (
                  <span
                    style={css(
                      "flex:0 0 auto; font-size:10.5px; padding:2px 6px; border-radius:5px; background:#efe7d6; color:#8a6d3b;",
                    )}
                  >
                    A/B
                  </span>
                )}
                <span style={css(MONO + "color:#b0b0aa; font-size:11px; flex:0 0 auto;")}>
                  +{step.delayDays}d
                </span>
              </div>
            ))}
          </div>
        )}

        {sequence.skipped.map((s) => (
          <div key={s.templateId} style={css(MUTED + "margin-top:6px;")}>
            Skipped “{s.name}” — {s.reason}.
          </div>
        ))}
        {sequence.problems.map((p) => (
          <div key={p} style={css("margin-top:7px; font-size:12px; color:#9a5b5b;")}>
            {p}
          </div>
        ))}
      </div>

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
            Pushes {maxLeadPush} at a time — press again to continue.
          </div>
        )}
        {leads.inOtherCampaign > 0 && (
          <div style={css(MUTED + "margin-top:7px;")}>
            Contacts in both loops are held back so they aren’t emailed by two campaigns
            at once.
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
          Numbers land on each template’s variant counters over on Templates.
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
            This <strong>replaces every step</strong> in the Smartlead campaign — including
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
