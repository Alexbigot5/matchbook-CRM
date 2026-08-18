import type { CSSProperties } from "react";
import { OWNERS } from "./data";
import {
  confidenceChip,
  EXAMPLE_BRIEFS,
  type Prospect,
  type RunView,
} from "./prospecting";
import { LIMITS } from "../lib/validate";
import {
  Box,
  Checkbox,
  css,
  IconCheck,
  IconClose,
  IconProspect,
  IconWarn,
  MONO,
} from "./ui";

// ---------------------------------------------------------------------------
// The prospecting agent's slide-over.
//
// Purely presentational plus callbacks, exactly as contact-detail.tsx is: it
// never submits and it never promotes, it raises onSend / onToggle / onPromote /
// onCancel / onClose and the page owns those. Imports ./data, ./prospecting,
// ./ui and ../lib/validate only — never sales-loop-crm.tsx, which imports THIS.
// Same bundle rule sidebar.tsx and contact-detail.tsx state in their headers.
//
// WHY THE CHECKLIST ONLY APPEARS AFTER A RUN FINISHES. Origami reports `running`
// and nothing else until a run is terminal — there is no mid-run progress feed.
// A five-step list ticking itself off live would therefore be an animation of
// information we do not have, so a running turn shows one row and an elapsed
// timer, and the checklist is assembled from the counts recorded at ingest.
//
// WHY THE COMPOSER IS A CONVERSATION, NOT A SEARCH BOX. An Origami agent keeps
// its workspace and conversation across runs, and a run can end `needs_input`
// with a question it needs answered before it will continue. So the composer
// sends a follow-up run on the same agent when a thread exists, which is both
// how a question gets answered and how a run that stopped early is resumed.
// ---------------------------------------------------------------------------

const CARD = "border:1px solid #ededea; border-radius:11px; background:#fff;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em;";
const GHOST =
  "background:#fff; border:1px solid #e6e6e2; border-radius:8px; padding:7px 12px; font-size:12.5px; font-family:inherit; color:#3a3a38; cursor:pointer; white-space:nowrap;";
const PRIMARY =
  "background:#1a1a1a; border:1px solid #1a1a1a; border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:500; font-family:inherit; color:#fff; cursor:pointer; white-space:nowrap;";
const MUTED = "font-size:11.5px; color:#9a9a95;";
const SELECT =
  "border:1px solid #e6e6e2; border-radius:7px; padding:5px 7px; font-size:11.5px; font-family:inherit; background:#fff; color:#3a3a38;";

/** The grid used by both the results header and its rows, so they cannot drift. */
const RESULT_GRID =
  "display:grid; grid-template-columns:17px minmax(0,1.6fr) minmax(0,1.3fr) 74px; gap:10px; align-items:center;";

export type ProspectingPanelProps = {
  /** Oldest turn first. Empty on a thread nobody has started. */
  turns: RunView[];
  draft: string;
  selected: string[];
  loop: number;
  owner: string;
  source: string;
  error: string;
  pending: boolean;
  /** False when ORIGAMI_API_KEY is unset. Everything stays read-only. */
  configured: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onLoop: (loop: number) => void;
  onOwner: (owner: string) => void;
  onSource: (source: string) => void;
  onPromote: () => void;
  onCancel: () => void;
  onExport: () => void;
  onClose: () => void;
};

export function ProspectingPanel({
  turns,
  draft,
  selected,
  loop,
  owner,
  source,
  error,
  pending,
  configured,
  onDraft,
  onSend,
  onToggle,
  onToggleAll,
  onLoop,
  onOwner,
  onSource,
  onPromote,
  onCancel,
  onExport,
  onClose,
}: ProspectingPanelProps) {
  const last = turns[turns.length - 1];
  const running = !!last?.running;
  // Only the newest turn's results are selectable. Older turns are history —
  // their rows are still shown, but a thread of four runs with four separate
  // selection sets is a footer that cannot say what "Add 3" means.
  const selectable = last && !last.running ? last.visible.filter((p) => !p.promotedContactId) : [];
  const selectedSet = new Set(selected);
  const chosen = selectable.filter((p) => selectedSet.has(p.id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  const canSend = configured && !pending && !running && !!draft.trim();

  return (
    <>
      <div
        onClick={onClose}
        style={css(
          "position:fixed; inset:0; background:rgba(20,20,18,0.18); z-index:50; animation:slcrm-fadeIn 0.15s ease;",
        )}
      />
      <div
        style={css(
          // Wider than the 480px contact detail: the results table carries four
          // columns and an email address, and 480 wraps every one of them.
          "position:fixed; top:0; right:0; bottom:0; width:560px; max-width:96vw; background:#fff; z-index:51; box-shadow:-8px 0 40px rgba(0,0,0,0.1); display:flex; flex-direction:column; animation:slcrm-slideIn 0.18s cubic-bezier(0.2,0.8,0.2,1);",
        )}
      >
        {/* HEADER */}
        <div
          style={css(
            "padding:18px 22px 15px; border-bottom:1px solid #ededea; display:flex; align-items:flex-start; gap:11px;",
          )}
        >
          <span
            style={css(
              "width:32px; height:32px; border-radius:9px; background:#f2f2ef; color:#6b6b66; display:flex; align-items:center; justify-content:center; flex:0 0 auto;",
            )}
          >
            <IconProspect size={17} />
          </span>
          <div style={css("flex:1; min-width:0;")}>
            <div style={css("font-size:15px; font-weight:600; letter-spacing:-0.01em;")}>
              Prospecting agent
            </div>
            <div style={css(MUTED + "margin-top:1px;")}>
              Searches, scrapes and enriches. Results land in your contacts.
            </div>
          </div>
          <Box
            as="button"
            onClick={onClose}
            title="Close"
            style={css(
              "border:none; background:#f2f2ef; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66; flex:0 0 auto;",
            )}
            hover={css("background:#e8e8e4;")}
          >
            <IconClose />
          </Box>
        </div>

        {/* BODY */}
        <div style={css("flex:1; overflow-y:auto; padding:14px 22px 20px;")}>
          {!configured && (
            <div
              style={css(
                "margin-bottom:14px; padding:10px 12px; border:1px solid #ecdfc4; background:#fdf8ee; border-radius:9px; font-size:12.5px; color:#8a6d3b; display:flex; gap:8px; align-items:flex-start;",
              )}
            >
              <IconWarn size={14} style={css("flex:0 0 auto; margin-top:1px;")} />
              <span>
                Origami isn’t connected, so nothing below can run. Set the key and reload.
                <br />
                <code style={css(MONO + "font-size:11.5px;")}>
                  wrangler secret put ORIGAMI_API_KEY
                </code>
              </span>
            </div>
          )}

          {error && (
            <div
              style={css(
                "margin-bottom:14px; padding:9px 12px; border:1px solid #eddede; background:#fbf3f3; border-radius:9px; font-size:12.5px; color:#9a5b5b;",
              )}
            >
              {error}
            </div>
          )}

          {!turns.length && <EmptyThread onPick={onDraft} disabled={!configured} />}

          {turns.map((turn, index) => (
            <Turn
              key={turn.run.id}
              turn={turn}
              last={index === turns.length - 1}
              selectedSet={selectedSet}
              selectable={index === turns.length - 1}
              allChosen={allChosen}
              someChosen={chosen.length > 0}
              pending={pending}
              onToggle={onToggle}
              onToggleAll={() => onToggleAll(selectable.map((p) => p.id))}
              onCancel={onCancel}
            />
          ))}
        </div>

        {/* FOOTER: what happens to the ticked rows */}
        {selectable.length > 0 && (
          <div
            style={css(
              "border-top:1px solid #ededea; background:#fbfbfa; padding:11px 22px; display:flex; align-items:center; gap:9px; flex-wrap:wrap;",
            )}
          >
            <div style={css(MUTED + "flex:1; min-width:120px;")}>
              {chosen.length} selected
            </div>
            <select
              value={String(loop)}
              onChange={(e) => onLoop(Number(e.currentTarget.value))}
              style={css(SELECT)}
              title="Which loop these contacts join"
            >
              <option value="1">Loop 1</option>
              <option value="2">Loop 2</option>
            </select>
            <select
              value={owner}
              onChange={(e) => onOwner(e.currentTarget.value)}
              style={css(SELECT)}
              title="Who owns these contacts"
            >
              <option value="Unassigned">Unassigned</option>
              {Object.keys(OWNERS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {/* Loop 2 only: a source is the community or event a contact came
                from, and Loop 1 has no such origin. The server drops it on
                Loop 1 rather than storing a label that means nothing there. */}
            {loop === 2 && (
              <input
                value={source}
                onChange={(e) => onSource(e.currentTarget.value)}
                placeholder="Source"
                maxLength={LIMITS.source}
                style={css(SELECT + "width:96px;")}
              />
            )}
            <Box
              as="button"
              onClick={onExport}
              style={css(GHOST + "padding:5px 10px; font-size:11.5px;")}
              hover={css("background:#f4f4f1;")}
            >
              Export CSV
            </Box>
            <Box
              as="button"
              onClick={onPromote}
              disabled={pending || !chosen.length}
              style={css(
                PRIMARY +
                  `padding:5px 12px; font-size:11.5px; opacity:${pending || !chosen.length ? "0.5" : "1"};`,
              )}
              hover={css("background:#333;")}
            >
              {pending ? "Adding…" : `Add ${chosen.length} to Loop ${loop}`}
            </Box>
          </div>
        )}

        {/* COMPOSER */}
        <div
          style={css(
            "border-top:1px solid #ededea; padding:12px 22px 14px; display:flex; gap:8px; align-items:center;",
          )}
        >
          <Box
            as="input"
            value={draft}
            maxLength={LIMITS.prospectPrompt}
            disabled={!configured || running}
            onChange={(e: any) => onDraft(e.currentTarget.value)}
            onKeyDown={(e: any) => {
              // ⌘↵ and plain ↵ both send. The field is one line, so unlike the
              // note textarea there is nothing a bare Enter would otherwise do.
              if (e.key === "Enter" && canSend) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={
              running
                ? "The agent is working…"
                : turns.length
                  ? "Ask a follow-up, or answer the question…"
                  : "Describe who you're looking for…"
            }
            style={css(
              "flex:1; min-width:0; padding:9px 12px; border:1px solid #e6e6e2; border-radius:9px; font-size:13px; font-family:inherit; background:#fbfbfa; outline:none; color:#1a1a1a;",
            )}
            focus={css("border-color:#c9c9c3; background:#fff;")}
          />
          <Box
            as="button"
            onClick={onSend}
            disabled={!canSend}
            title="Send to the agent"
            style={css(
              `width:34px; height:34px; flex:0 0 auto; border:none; border-radius:9px; background:#1a1a1a; color:#fff; display:flex; align-items:center; justify-content:center; cursor:${canSend ? "pointer" : "default"}; opacity:${canSend ? "1" : "0.4"};`,
            )}
            hover={css(canSend ? "background:#333;" : "")}
          >
            <ArrowRight />
          </Box>
        </div>
      </div>
    </>
  );
}

/** The only glyph this panel needs that ui.tsx doesn't already carry. */
function ArrowRight({ style }: { style?: CSSProperties }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M5 12h13m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Suggestion chips, shown only before a thread exists. */
function EmptyThread({ onPick, disabled }: { onPick: (value: string) => void; disabled: boolean }) {
  return (
    <div>
      <div style={css(COL_LABEL + "margin-bottom:8px;")}>Try</div>
      <div style={css("display:flex; flex-direction:column; gap:7px;")}>
        {EXAMPLE_BRIEFS.map((brief) => (
          <Box
            key={brief}
            as="button"
            disabled={disabled}
            onClick={() => onPick(brief)}
            style={css(
              CARD +
                `padding:10px 13px; text-align:left; font-size:12.5px; font-family:inherit; color:#3a3a38; cursor:${disabled ? "default" : "pointer"}; width:100%;`,
            )}
            hover={css(disabled ? "" : "background:#fafaf9; border-color:#e2e2dd;")}
          >
            {brief}
          </Box>
        ))}
      </div>
    </div>
  );
}

/** One brief and everything that came back from it. */
function Turn({
  turn,
  last,
  selectable,
  selectedSet,
  allChosen,
  someChosen,
  pending,
  onToggle,
  onToggleAll,
  onCancel,
}: {
  turn: RunView;
  last: boolean;
  selectable: boolean;
  selectedSet: Set<string>;
  allChosen: boolean;
  someChosen: boolean;
  pending: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onCancel: () => void;
}) {
  const { run } = turn;

  return (
    <div style={css(last ? "" : "margin-bottom:22px; opacity:0.72;")}>
      {/* The brief, as the user typed it */}
      <div style={css("display:flex; justify-content:flex-end; margin-bottom:11px;")}>
        <div
          style={css(
            "max-width:82%; background:#1a1a1a; color:#fff; border-radius:11px; padding:9px 13px; font-size:12.5px; line-height:1.5;",
          )}
        >
          {run.prompt}
        </div>
      </div>

      {turn.running ? (
        <div style={css(CARD + "padding:13px 15px; display:flex; align-items:center; gap:11px;")}>
          <Spinner />
          <div style={css("flex:1; min-width:0;")}>
            <div style={css("font-size:12.5px; color:#3a3a38;")}>
              {run.stage === "reading" ? "Reading the results…" : "Researching…"}
            </div>
            {/* The only honest progress signal available: Origami reports no
                intermediate state, so this is elapsed time, not percent done. */}
            <div style={css(MUTED + "margin-top:1px;")}>
              {run.stage === "reading"
                ? "The agent finished. Pulling its table across."
                : `${formatElapsed(run.elapsedSeconds)} elapsed · usually one to five minutes`}
            </div>
          </div>
          {/* Cancel only reaches Origami while Origami still has the run. Once
              it has handed back a table there is nothing upstream to stop. */}
          {run.stage !== "reading" && (
            <Box
              as="button"
              onClick={onCancel}
              disabled={pending}
              style={css(GHOST + "padding:5px 10px; font-size:11.5px;")}
              hover={css("background:#f4f4f1;")}
            >
              Cancel
            </Box>
          )}
        </div>
      ) : (
        <>
          {turn.checklist.length > 0 && (
            <div style={css(CARD + "padding:11px 14px; margin-bottom:10px;")}>
              {turn.checklist.map((step) => (
                <div
                  key={step.key}
                  style={css("display:flex; gap:9px; align-items:flex-start; padding:4px 0;")}
                >
                  <span
                    style={css(
                      `flex:0 0 auto; margin-top:2px; color:${step.state === "warn" ? "#b0932f" : "#5f8a5f"};`,
                    )}
                  >
                    {step.state === "warn" ? <IconWarn size={13} /> : <IconCheck style={css("width:13px; height:13px;")} />}
                  </span>
                  <div style={css("min-width:0;")}>
                    <div style={css("font-size:12.5px; color:#2a2a28;")}>{step.label}</div>
                    {step.detail && <div style={css(MUTED)}>{step.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* The agent's own words, when it left any. Never rendered for an
              errored or timed_out run — Origami documents response.text as null
              for both, and turn.failed carries the reason instead. */}
          {run.summary && !turn.failed && (
            <div style={css("font-size:12.5px; color:#3a3a38; line-height:1.55; margin-bottom:10px;")}>
              {run.summary}
            </div>
          )}

          {turn.failed && <Notice tone="bad">{turn.headline}</Notice>}

          {run.question && !turn.failed && (
            <Notice tone="warn">
              <strong style={css("font-weight:600;")}>The agent has a question.</strong> {run.question}
              <div style={css("margin-top:4px;")}>Answer it below and it will pick up where it left off.</div>
            </Notice>
          )}

          {/* incomplete, step_cap_hit and cancelled all keep whatever the run
              built, so a follow-up continues from here rather than starting over. */}
          {turn.resumable && !run.question && !turn.failed && (
            <Notice tone="warn">{resumableReason(run.status)}</Notice>
          )}

          {!turn.failed && !run.question && !turn.running && (
            <div style={css("font-size:12.5px; color:#3a3a38; margin-bottom:9px;")}>
              {turn.headline}
            </div>
          )}

          {turn.visible.length > 0 && (
            <div style={css(CARD + "overflow:hidden;")}>
              <div
                style={css(
                  RESULT_GRID + "padding:8px 13px; border-bottom:1px solid #f2f2f0; background:#fbfbfa;",
                )}
              >
                {selectable ? (
                  <Checkbox
                    checked={allChosen}
                    indeterminate={someChosen && !allChosen}
                    onClick={onToggleAll}
                    title={allChosen ? "Clear selection" : "Select all"}
                  />
                ) : (
                  <span />
                )}
                <span style={css(COL_LABEL)}>Prospect</span>
                <span style={css(COL_LABEL)}>Email</span>
                <span style={css(COL_LABEL + "text-align:right;")}>Conf.</span>
              </div>
              {turn.visible.map((p) => (
                <Row
                  key={p.id}
                  prospect={p}
                  selectable={selectable}
                  checked={selectedSet.has(p.id)}
                  onToggle={() => onToggle(p.id)}
                />
              ))}
            </div>
          )}

          {turn.hidden > 0 && (
            <div style={css(MUTED + "margin-top:7px;")}>
              {turn.hidden} already in Match Book, removed.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({
  prospect,
  selectable,
  checked,
  onToggle,
}: {
  prospect: Prospect;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const chip = confidenceChip(prospect.emailConfidence);
  const added = !!prospect.promotedContactId;
  const subtitle = [prospect.title, prospect.company].filter(Boolean).join(" · ");

  return (
    <div style={css(RESULT_GRID + "padding:9px 13px; border-bottom:1px solid #f5f5f3;")}>
      {selectable && !added ? (
        <Checkbox checked={checked} onClick={onToggle} title="Select" />
      ) : (
        <span
          title={added ? "Already added to your contacts" : undefined}
          style={css(added ? "color:#5f8a5f; display:flex;" : "")}
        >
          {added ? <IconCheck style={css("width:13px; height:13px;")} /> : null}
        </span>
      )}
      <div style={css("min-width:0;")}>
        <div
          style={css(
            "font-size:12.5px; color:#1a1a1a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
          )}
        >
          {/* The source URL is the only route back to the evidence for a
              machine-found claim, so the name carries it when there is one. */}
          {prospect.sourceUrl ? (
            <Box
              as="a"
              href={prospect.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={css("color:inherit; text-decoration:none;")}
              hover={css("text-decoration:underline;")}
            >
              {prospect.name}
            </Box>
          ) : (
            prospect.name
          )}
        </div>
        {subtitle && (
          <div
            style={css(
              MUTED + "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
            )}
          >
            {subtitle}
          </div>
        )}
      </div>
      <div
        style={css(
          MONO +
            "font-size:11px; color:#75756f; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
        )}
        title={prospect.email ?? undefined}
      >
        {prospect.email ?? "—"}
      </div>
      <div style={css("text-align:right;")}>
        <span
          title={chip.title}
          style={css(
            `display:inline-block; padding:2px 7px; border-radius:6px; font-size:10.5px; background:${chip.bg}; color:${chip.fg};`,
          )}
        >
          {chip.label}
        </span>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "bad"; children: React.ReactNode }) {
  const style =
    tone === "bad"
      ? "border:1px solid #eddede; background:#fbf3f3; color:#9a5b5b;"
      : "border:1px solid #ecdfc4; background:#fdf8ee; color:#8a6d3b;";
  return (
    <div
      style={css(
        style + "padding:9px 12px; border-radius:9px; font-size:12.5px; line-height:1.5; margin-bottom:10px;",
      )}
    >
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={css(
        // Borrows slcrm-fadeIn's home in GLOBAL_CSS rather than adding a fourth
        // keyframe: a pulsing dot reads as "working" without a spin animation
        // this stylesheet doesn't define.
        "width:9px; height:9px; flex:0 0 auto; border-radius:50%; background:#b0932f; animation:slcrm-fadeIn 0.9s ease-in-out infinite alternate;",
      )}
    />
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function resumableReason(status: string): string {
  if (status === "step_cap_hit") {
    return "The run hit this Origami plan's step limit. A follow-up continues from where it stopped.";
  }
  if (status === "cancelled") {
    return "Cancelled. Whatever the agent had already built is kept below.";
  }
  return "The run stopped early. A follow-up continues from where it left off.";
}
