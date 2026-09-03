// The "Email campaigns" sub-page of /analytics.
//
// Read-only, like the rest of that route: no fetcher, no action. Every figure and
// every colour is precomputed by computeCampaigns() in ./campaigns.ts, so this
// file is a plain mapper — the same split ./analytics-page.tsx makes over
// ./analytics.ts. Charts are plain divs with percentage heights; the repo has no
// charting dependency and this page didn't warrant adding one.
//
// The style constants below are deliberately local rather than imported from
// ./analytics-page.tsx: importing them back would make the two modules circular,
// and per-file CARD/COL_LABEL constants are already the convention here (see
// ./prospecting-panel.tsx, ./templates-page.tsx, ./smartlead-page.tsx).

import type { ReactNode } from "react";
import type { CampaignLoopView } from "./campaigns";
import { loopBadge } from "./data";
import { Box, css, MONO } from "./ui";

const CARD = "border:1px solid #ededea; border-radius:11px; background:#fff;";
const PANEL_HEAD =
  "display:flex; align-items:baseline; gap:10px; padding:12px 14px; border-bottom:1px solid #f0f0ec;";
const PANEL_TITLE = "font-size:13px; font-weight:600; color:#1a1a1a;";
const PANEL_HINT = "font-size:11.5px; color:#a3a39d;";
const PANEL_CAPTION =
  "padding:9px 14px; border-top:1px solid #f4f4f1; background:#fbfbfa; font-size:11.5px; color:#a3a39d;";
const PANEL_EMPTY = "padding:26px 14px; text-align:center; font-size:12.5px; color:#a3a39d;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.04em;";
const OWNER_COLS =
  "display:grid; grid-template-columns:minmax(0,1.6fr) 96px 96px 104px; gap:10px; align-items:center; padding:11px 14px;";

function Panel({
  title,
  hint,
  caption,
  children,
}: {
  title: string;
  hint?: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section style={css(CARD + "overflow:hidden;")}>
      <div style={css(PANEL_HEAD)}>
        <span style={css(PANEL_TITLE)}>{title}</span>
        {hint && <span style={css(PANEL_HINT + "margin-left:auto;")}>{hint}</span>}
      </div>
      {children}
      {caption && <div style={css(PANEL_CAPTION)}>{caption}</div>}
    </section>
  );
}

/** A rate cell. Null means "nothing was sent on this step", not zero percent. */
function Rate({ value }: { value: number | null }) {
  if (value === null) return <span style={css(MONO + "font-size:11.5px; color:#c4c4be;")}>-</span>;
  return <span style={css(MONO + "font-size:11.5px; color:#a3a39d;")}>({value}%)</span>;
}

/**
 * One SENT / OPENED / CLICKED / REPLIED box under a step card.
 *
 * A null `value` renders nothing at all rather than a zero: the two sources this
 * page reads carry different figures (events have clicks and no meetings, the
 * variant counters the reverse), and printing 0 for a number that was never
 * measured is the one thing worse than leaving the box out.
 */
function StatBox({
  label,
  value,
  rate,
  color,
}: {
  label: string;
  value: number | null;
  rate?: number | null;
  color: string;
}) {
  if (value === null) return null;
  return (
    <div style={css("border:1px solid #f0f0ec; border-radius:9px; padding:9px 11px; min-width:0;")}>
      <div style={css(COL_LABEL)}>{label}</div>
      <div style={css("display:flex; align-items:baseline; gap:6px; margin-top:5px;")}>
        <span style={css(MONO + `font-size:17px; font-weight:500; color:${color};`)}>{value}</span>
        {rate !== undefined && <Rate value={rate} />}
      </div>
    </div>
  );
}

/** The Loop 1 / Loop 2 segmented control. */
function LoopSwitch({ loop, onLoop }: { loop: number; onLoop: (n: number) => void }) {
  return (
    <div
      style={css(
        "display:inline-flex; gap:2px; padding:2px; border:1px solid #ededea; border-radius:9px; background:#fbfbfa; flex:0 0 auto;",
      )}
    >
      {[1, 2].map((n) => {
        const active = n === loop;
        return (
          <Box
            key={n}
            as="button"
            type="button"
            onClick={() => onLoop(n)}
            aria-pressed={active}
            style={css(
              "padding:5px 12px; border-radius:7px; font-size:12.5px; font-family:inherit; cursor:pointer; border:1px solid transparent;" +
                (active
                  ? "background:#fff; border-color:#ededea; color:#1a1a1a; font-weight:500;"
                  : "background:transparent; color:#75756f;"),
            )}
            hover={active ? undefined : css("color:#1a1a1a; background:#f2f2ee;")}
          >
            {loopBadge(n, true).label}
          </Box>
        );
      })}
    </div>
  );
}

export function CampaignsPanel({
  view,
  loop,
  onLoop,
}: {
  view: CampaignLoopView;
  loop: number;
  onLoop: (n: number) => void;
}) {
  const chart = view.chart;

  return (
    <>
      {/* CAMPAIGN HEADER */}
      <section style={css(CARD + "padding:14px 16px; display:flex; align-items:flex-start; gap:14px;")}>
        <div style={css("min-width:0; flex:1 1 auto;")}>
          <div style={css("display:flex; align-items:center; gap:10px; flex-wrap:wrap;")}>
            <span style={css("font-size:15px; font-weight:600; color:#1a1a1a;")}>{view.title}</span>
            <span style={css(view.badge.style)}>{view.badge.label}</span>
          </div>
          <div style={css("font-size:12.5px; color:#9a9a95; margin-top:3px;")}>{view.subtitle}</div>
        </div>
        <LoopSwitch loop={loop} onLoop={onLoop} />
      </section>

      {view.contacts === 0 && view.steps.length === 0 ? (
        <section style={css(CARD)}>
          <div style={css(PANEL_EMPTY)}>
            Nothing on {loopBadge(loop, true).label} yet — no contacts and no sequence steps.
          </div>
        </section>
      ) : (
        <>
          {/* PROGRESS + KPIs */}
          <div style={css("display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px;")}>
            <Panel title="Campaign progress" caption={view.freshness}>
              <div style={css("padding:14px 14px 4px;")}>
                <div
                  style={css(
                    MONO +
                      "font-size:30px; font-weight:500; letter-spacing:-0.02em; line-height:1.1; color:#1a1a1a;",
                  )}
                >
                  {view.progress.capacity > 0 ? `${view.progress.pctComplete}% complete` : "-"}
                </div>
                <div style={css("font-size:11.5px; color:#9a9a95; margin-top:4px;")}>
                  {view.progress.caption}
                </div>
              </div>
              <div style={css("padding:8px 0 12px;")}>
                {view.progress.rows.map((r) => (
                  <div key={r.key} style={css("padding:6px 14px;")}>
                    <div style={css("display:flex; align-items:center; gap:8px;")}>
                      <span
                        style={css(
                          `width:7px; height:7px; border-radius:4px; background:${r.color}; flex:0 0 auto;`,
                        )}
                      />
                      <span
                        style={css(
                          "font-size:12.5px; color:#3a3a38; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                        )}
                      >
                        {r.label}
                      </span>
                      <span style={css(MONO + "margin-left:auto; font-size:11.5px; color:#a3a39d; white-space:nowrap;")}>
                        {r.count} of {view.contacts} · {r.pct}%
                      </span>
                    </div>
                    <span
                      style={css(
                        "display:block; height:6px; border-radius:4px; background:#f2f2f0; overflow:hidden; margin-top:5px;",
                      )}
                    >
                      <span
                        style={css(
                          `display:block; height:100%; border-radius:4px; background:${r.color}; width:${r.barWidth};`,
                        )}
                      />
                    </span>
                  </div>
                ))}
              </div>
            </Panel>

            <div
              style={css(
                "display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; align-content:start;",
              )}
            >
              {view.kpis.map((k) => (
                <div key={k.key} style={css(CARD + "padding:13px 14px;")}>
                  <div style={css(COL_LABEL + "letter-spacing:0.05em;")}>{k.label}</div>
                  <div
                    style={css(
                      MONO +
                        `font-size:24px; font-weight:500; letter-spacing:-0.02em; line-height:1.1; margin-top:6px; color:${k.color};`,
                    )}
                  >
                    {k.value}
                  </div>
                  <div style={css("font-size:11.5px; color:#9a9a95; margin-top:4px;")}>{k.sub}</div>
                </div>
              ))}
              {view.deliverability && (
                <div style={css("grid-column:1 / -1; font-size:11.5px; color:#a3a39d;")}>
                  {view.deliverability}
                </div>
              )}
            </div>
          </div>

          {/* DAILY VOLUME */}
          <Panel
            title={`${chart.series.map((s) => s.label).join(", ")} · last ${chart.days.length} days`}
            hint={chart.total ? `${chart.total} events` : undefined}
            caption={chart.caption}
          >
            {chart.total === 0 ? (
              <div style={css(PANEL_EMPTY)}>
                Nothing recorded in the last {chart.days.length} days.
              </div>
            ) : (
              <>
                <div style={css("display:flex; align-items:flex-end; gap:6px; height:150px; padding:14px 14px 0;")}>
                  {chart.days.map((day, i) => (
                    <div
                      key={i}
                      title={`${day.label} · ${day.bars.map((b) => `${b.count} ${b.key}`).join(", ")}`}
                      style={css("flex:1 1 0; min-width:0; height:100%; display:flex; align-items:flex-end; gap:2px;")}
                    >
                      {day.total === 0 ? (
                        // A stub keeps the baseline reading continuously across quiet days.
                        <span style={css("width:100%; height:2px; border-radius:2px; background:#f2f2f0;")} />
                      ) : (
                        day.bars.map((bar) => (
                          <span
                            key={bar.key}
                            style={css(
                              `flex:1 1 0; min-width:0; border-radius:2px 2px 0 0; background:${bar.color}; height:${bar.height};`,
                            )}
                          />
                        ))
                      )}
                    </div>
                  ))}
                </div>
                <div
                  style={css(
                    "display:flex; justify-content:space-between; padding:7px 14px 0;" +
                      MONO +
                      "font-size:11px; color:#a3a39d;",
                  )}
                >
                  <span>{chart.startLabel}</span>
                  <span>{chart.endLabel}</span>
                </div>
                <div style={css("display:flex; flex-wrap:wrap; gap:12px; padding:12px 14px 14px;")}>
                  {chart.series.map((s) => (
                    <span
                      key={s.key}
                      style={css("display:flex; align-items:center; gap:6px; font-size:11.5px; color:#75756f;")}
                    >
                      <span style={css(`width:8px; height:8px; border-radius:3px; background:${s.color};`)} />
                      {s.label}
                      <span style={css(MONO + "color:#a3a39d;")}>{s.count}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Panel>

          {/* SEQUENCE STEPS */}
          <div style={css("display:flex; flex-direction:column; gap:10px;")}>
            <div style={css("display:flex; align-items:baseline; gap:8px;")}>
              <span style={css("font-size:13px; font-weight:600; color:#1a1a1a;")}>
                Sequence step performance
              </span>
              <span style={css(MONO + "font-size:11.5px; color:#a3a39d;")}>{view.steps.length}</span>
            </div>

            {view.steps.length === 0 ? (
              <section style={css(CARD)}>
                <div style={css(PANEL_EMPTY)}>
                  No sequence steps for this loop. Build one on the Smartlead page.
                </div>
              </section>
            ) : (
              view.steps.map((step) => (
                <section key={step.key} style={css(CARD + "padding:13px 14px;")}>
                  <div style={css("display:flex; align-items:center; gap:9px; flex-wrap:wrap;")}>
                    <span style={css(MONO + "font-size:11.5px; color:#a3a39d;")}>
                      Step {step.seqNumber}
                    </span>
                    <span style={css("font-size:13.5px; font-weight:500; color:#1a1a1a;")}>{step.name}</span>
                    <span
                      style={css(
                        "display:inline-flex; align-items:center; padding:2px 7px; border-radius:6px; font-size:11px; background:#f2f2f0; color:#575753;",
                      )}
                    >
                      {step.variantLabel}
                    </span>
                    <span style={css(MONO + "font-size:11px; color:#a3a39d;")}>{step.dayLabel}</span>
                    <span style={css(step.verdictStyle + "margin-left:auto;")}>{step.verdict}</span>
                  </div>
                  <div
                    style={css(
                      "font-size:12px; color:#9a9a95; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                    )}
                    title={step.subject}
                  >
                    {step.subject || "No subject line on this variant."}
                  </div>
                  <div
                    style={css(
                      "display:grid; grid-template-columns:repeat(auto-fit, minmax(132px, 1fr)); gap:10px; margin-top:11px;",
                    )}
                  >
                    <StatBox label="Sent" value={step.sends} color="#1a1a1a" />
                    <StatBox label="Opened" value={step.opens} rate={step.openRate} color="#6d3fc4" />
                    <StatBox label="Clicked" value={step.clicks} rate={step.clickRate} color="#0a7ea4" />
                    <StatBox label="Replied" value={step.replies} rate={step.replyRate} color="#8b5cf6" />
                    <StatBox label="Meetings" value={step.meetings} rate={step.meetingRate} color="#22c55e" />
                  </div>
                </section>
              ))
            )}
            <div style={css("font-size:11.5px; color:#a3a39d;")}>{view.stepsCaption}</div>
          </div>

          {/* BY OWNER */}
          <Panel
            title="Sending by owner"
            caption="Sends are campaign emails Smartlead has reported; the reply rate is over this owner's contacts on the loop, not over sends."
          >
            {view.owners.length === 0 ? (
              <div style={css(PANEL_EMPTY)}>No contacts on this loop.</div>
            ) : (
              <div style={css("overflow-x:auto;")}>
                <div style={css("min-width:560px;")}>
                  <div style={css(OWNER_COLS + COL_LABEL + "padding-bottom:6px;")}>
                    <span>Owner</span>
                    <span style={css("text-align:right;")}>Contacts</span>
                    <span style={css("text-align:right;")}>Sends</span>
                    <span style={css("text-align:right;")}>Reply rate</span>
                  </div>
                  {view.owners.map((o) => (
                    <div key={o.key} style={css(OWNER_COLS + "border-top:1px solid #f4f4f1;")}>
                      <span style={css("display:flex; align-items:center; gap:9px; min-width:0;")}>
                        <span
                          style={css(
                            `width:24px; height:24px; border-radius:7px; background:${o.hasAvatar ? o.color : "#e8e8e4"}; color:${o.hasAvatar ? "#fff" : "#a3a39d"}; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto;`,
                          )}
                        >
                          {o.hasAvatar ? o.initial : "?"}
                        </span>
                        <span
                          style={css(
                            "font-size:13px; color:#1a1a1a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                          )}
                        >
                          {o.label}
                        </span>
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {o.contacts}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {o.sends}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {o.replyRate === null ? "-" : `${o.replyRate}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
