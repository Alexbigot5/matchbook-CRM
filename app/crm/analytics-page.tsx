// The /analytics view. Read-only: it defines no fetcher and no action, and every
// figure comes from computeAnalytics over the loader's contacts.
//
// Charts are plain divs — the repo has no charting dependency and this page didn't
// warrant adding one. Bars are percentage widths/heights over a fixed-size track,
// which also means they need no measurement, no effects, and no client-only code.
//
// TWO TABS, ONE SHELL. "Pipeline" is everything below; "Email campaigns" is
// ./campaigns-panel.tsx over ./campaigns.ts. They are tabs rather than two routes
// because they share the sidebar, the owner filter and the loader's single `now`,
// and splitting them would mean a second loader reading the same contacts.
//
// The two rails agree on the loop rather than contradicting each other: picking a
// loop in the sidebar moves the campaign tab's switch, and the switch writes the
// sidebar's view back. The campaign tab is loop-scoped by construction — a
// campaign belongs to exactly one loop (migration 0009) — so "All contacts" there
// means "keep the loop I last chose", and the switch always shows which one that
// is. The OWNER filter is orthogonal and applies on both tabs.

import { useState } from "react";
import { computeAnalytics, type AnalyticsLabels } from "./analytics";
import { computeCampaigns, type CampaignLoopInput } from "./campaigns";
import { CampaignsPanel } from "./campaigns-panel";
import { loopBadge, type Contact, type Viewer } from "./data";
import { buildOwnerTabs, buildViewTabs, Sidebar } from "./sidebar";
import { Box, css, GLOBAL_CSS, IconChart, IconMail, MONO } from "./ui";
import type { ReactNode } from "react";

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

function Panel({
  title,
  hint,
  caption,
  children,
  style,
}: {
  title: string;
  hint?: string;
  caption?: string;
  children: ReactNode;
  style?: string;
}) {
  return (
    <section style={css(CARD + "overflow:hidden;" + (style ?? ""))}>
      <div style={css(PANEL_HEAD)}>
        <span style={css(PANEL_TITLE)}>{title}</span>
        {hint && <span style={css(PANEL_HINT + "margin-left:auto;")}>{hint}</span>}
      </div>
      {children}
      {caption && <div style={css(PANEL_CAPTION)}>{caption}</div>}
    </section>
  );
}

/** A rate cell. Null means "nothing reached on this channel", not zero percent. */
function RatePill({ value }: { value: number | null }) {
  if (value === null) {
    return <span style={css(MONO + "font-size:11.5px; color:#c4c4be;")}>-</span>;
  }
  const tone = value > 0 ? "background:#e4f3ea; color:#1f7a4d;" : "background:#f2f2f0; color:#a3a39d;";
  return (
    <span
      style={css(
        "display:inline-flex; align-items:center; padding:2px 8px; border-radius:6px; font-size:11.5px; font-weight:500;" +
          MONO +
          tone,
      )}
    >
      {value}%
    </span>
  );
}

function BarRow({
  label,
  color,
  width,
  value,
}: {
  label: ReactNode;
  color: string;
  width: string;
  value: string;
}) {
  return (
    <div
      style={css(
        "display:grid; grid-template-columns:132px minmax(0,1fr) 92px; gap:12px; align-items:center; padding:7px 14px;",
      )}
    >
      <span style={css("font-size:12.5px; color:#3a3a38; display:flex; align-items:center; gap:8px; min-width:0;")}>
        {label}
      </span>
      <span style={css("height:8px; border-radius:5px; background:#f2f2f0; overflow:hidden;")}>
        <span
          style={css(`display:block; height:100%; border-radius:5px; background:${color}; width:${width};`)}
        />
      </span>
      <span style={css(MONO + "font-size:11.5px; color:#a3a39d; text-align:right;")}>{value}</span>
    </div>
  );
}

/** Horizontally scrollable table body — narrow viewports scroll the grid, not the page. */
function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div style={css("overflow-x:auto;")}>
      <div style={css("min-width:660px;")}>{children}</div>
    </div>
  );
}

const CHANNEL_COLS =
  "display:grid; grid-template-columns:minmax(0,1.6fr) 84px 84px 96px 90px 104px; gap:10px; align-items:center; padding:10px 14px;";
const SOURCE_COLS =
  "display:grid; grid-template-columns:minmax(0,1.6fr) 92px 92px 92px 92px 104px; gap:10px; align-items:center; padding:10px 14px;";

/** The two sub-pages, in the order the tab strip renders them. */
const TABS = [
  { key: "pipeline", label: "Pipeline", Icon: IconChart },
  { key: "campaigns", label: "Email campaigns", Icon: IconMail },
] as const;

export function AnalyticsPage({
  contacts,
  viewer,
  labels,
  campaigns,
}: {
  contacts: Contact[];
  viewer: Viewer;
  labels: AnalyticsLabels;
  campaigns: CampaignLoopInput[];
}) {
  const [S, setS] = useState({ view: "all", owner: "all", tab: "pipeline", loop: 1 });
  const patch = (u: Partial<typeof S>) => setS((s) => ({ ...s, ...u }));

  // Same predicates as the contacts page, so the two rails filter identically.
  const byView = (c: Contact) =>
    S.view === "all" ? true : S.view === "loop1" ? c.loops.includes(1) : c.loops.includes(2);
  const byOwner = (c: Contact) =>
    S.owner === "all" ? true : S.owner === "unassigned" ? !c.owner : c.owner === S.owner;

  // Rail counts are over the unfiltered list; the metrics are over the filtered one.
  // A loop row also moves the campaign tab's switch, so the two never contradict
  // each other; "All contacts" leaves the last chosen loop in place, since a
  // campaign is per-loop and there is no "both" campaign to show.
  const viewTabs = buildViewTabs(contacts, S.view, (key) =>
    patch(key === "loop1" ? { view: key, loop: 1 } : key === "loop2" ? { view: key, loop: 2 } : { view: key }),
  );
  const ownerTabs = buildOwnerTabs(contacts, S.owner, (key) => patch({ owner: key }));

  const scoped = contacts.filter((c) => byView(c) && byOwner(c));
  const A = computeAnalytics(scoped, labels);

  // The campaign tab scopes by its own loop switch, so only the owner filter is
  // applied here — computeCampaigns() picks the loop out of the list itself.
  const C = computeCampaigns(contacts.filter(byOwner), {
    dayLabels: labels.dayLabels,
    dayKeys: labels.dayKeys,
    loops: campaigns,
  });
  // A loop the loader didn't describe can't happen (it always sends both), but
  // falling back beats rendering `undefined` if that ever changes.
  const campaignView = C.loops.find((l) => l.loop === S.loop) ?? C.loops[0];

  const ownerScope = S.owner === "all" ? "" : S.owner === "unassigned" ? "unassigned" : S.owner;
  const scope = [
    S.view === "loop1" ? "Loop 1" : S.view === "loop2" ? "Loop 2" : "",
    ownerScope,
  ].filter(Boolean);
  const headerSub =
    S.tab === "campaigns"
      ? [`Sequence performance · as of ${A.asOf}`, `Loop ${S.loop}`, ownerScope]
          .filter(Boolean)
          .join(" · ")
      : `Pipeline, sources and activity · as of ${A.asOf}` +
        (scope.length ? ` · ${scope.join(" · ")}` : "");

  return (
    <div
      className="slcrm"
      style={css("display:flex; height:100vh; width:100%; overflow:hidden; background:#ffffff;")}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar nav="analytics" viewTabs={viewTabs} ownerTabs={ownerTabs} viewer={viewer} />

      <main style={css("flex:1; display:flex; flex-direction:column; min-width:0; background:#ffffff;")}>
        <div
          style={css(
            "display:flex; align-items:center; gap:14px; padding:16px 24px; border-bottom:1px solid #ededea;",
          )}
        >
          <div style={css("min-width:0;")}>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>Analytics</div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:1px;")}>{headerSub}</div>
          </div>
        </div>

        <div
          style={css(
            "display:flex; align-items:center; gap:6px; padding:10px 24px; border-bottom:1px solid #ededea; background:#fbfbfa;",
          )}
        >
          {TABS.map((t) => {
            const active = S.tab === t.key;
            return (
              <Box
                key={t.key}
                as="button"
                type="button"
                onClick={() => patch({ tab: t.key })}
                aria-pressed={active}
                style={css(
                  "display:inline-flex; align-items:center; gap:7px; padding:6px 12px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer; border:1px solid transparent;" +
                    (active
                      ? "background:#fff; border-color:#ededea; color:#1a1a1a; font-weight:500;"
                      : "background:transparent; color:#75756f;"),
                )}
                hover={active ? undefined : css("color:#1a1a1a; background:#f2f2ee;")}
              >
                <t.Icon style={css("flex:0 0 auto;")} />
                {t.label}
              </Box>
            );
          })}
        </div>

        <div style={css("flex:1; overflow-y:auto; overflow-x:hidden;")}>
          <div
            style={css(
              "padding:18px 24px 48px; display:flex; flex-direction:column; gap:18px; max-width:1180px;",
            )}
          >
            {S.tab === "campaigns" ? (
              <CampaignsPanel
                view={campaignView}
                loop={S.loop}
                onLoop={(n) => patch({ loop: n, view: n === 2 ? "loop2" : "loop1" })}
              />
            ) : (
              <>
            {/* KPI ROW */}
            <div
              style={css(
                "display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px;",
              )}
            >
              {A.kpis.map((k) => (
                <div key={k.key} style={css(CARD + "padding:13px 14px;")}>
                  <div
                    style={css(
                      "font-size:11px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.05em;",
                    )}
                  >
                    {k.label}
                  </div>
                  <div
                    style={css(
                      MONO +
                        "font-size:26px; font-weight:500; letter-spacing:-0.02em; line-height:1.1; margin-top:6px; color:#1a1a1a;",
                    )}
                  >
                    {k.value}
                  </div>
                  <div style={css("font-size:11.5px; color:#9a9a95; margin-top:4px;")}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* PIPELINE + LOOPS */}
            <div
              style={css("display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px;")}
            >
              <Panel title="Pipeline by stage">
                <div style={css("padding:6px 0 10px;")}>
                  {A.stages.map((s) => (
                    <BarRow
                      key={s.id}
                      color={s.dot}
                      width={s.barWidth}
                      value={`${s.count} · ${s.pct}%`}
                      label={
                        <>
                          <span
                            style={css(`width:7px; height:7px; border-radius:4px; background:${s.dot}; flex:0 0 auto;`)}
                          />
                          <span style={css("overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")}>
                            {s.id}
                          </span>
                        </>
                      }
                    />
                  ))}
                </div>
              </Panel>

              <Panel title="Loop comparison" caption="A contact resumed into Loop 1 counts in both.">
                <div
                  style={css(
                    "padding:14px; display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px;",
                  )}
                >
                  {A.loops.map((l) => {
                    const badge = loopBadge(l.loop, false);
                    const tint =
                      l.loop === 2
                        ? "border:1px solid #f0e4cf; background:#faf3e6;"
                        : "border:1px solid #ededea; background:#fbfbfa;";
                    const rows: [string, string][] = [
                      ["Contacts", String(l.contacts)],
                      ["Touched", l.touchedRate === null ? "-" : `${l.touchedRate}%`],
                      ["Meetings", String(l.meetings)],
                      ["Won", String(l.won)],
                    ];
                    return (
                      <div key={l.loop} style={css(`border-radius:10px; padding:12px 13px; ${tint}`)}>
                        <span style={css(badge.style)} title={badge.title}>
                          {badge.label}
                        </span>
                        <div style={css("margin-top:8px;")}>
                          {rows.map(([label, value]) => (
                            <div
                              key={label}
                              style={css(
                                "display:flex; justify-content:space-between; align-items:center; padding:5px 0; font-size:12.5px; color:#575753;",
                              )}
                            >
                              <span>{label}</span>
                              <span style={css(MONO + "color:#1a1a1a;")}>{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            </div>

            {/* BY CHANNEL */}
            <Panel
              title="By channel"
              hint="Rates are per contact reached on that channel"
              caption="A contact reached on several channels counts once in each, so these need not sum to the headline numbers."
            >
              <TableScroll>
                <div style={css(CHANNEL_COLS + COL_LABEL + "padding-bottom:6px;")}>
                  <span>Channel</span>
                  <span style={css("text-align:right;")}>Touches</span>
                  <span style={css("text-align:right;")}>Replies</span>
                  <span style={css("text-align:right;")}>Reply rate</span>
                  <span style={css("text-align:right;")}>Meetings</span>
                  <span style={css("text-align:right;")}>Meeting rate</span>
                </div>
                {A.channels.map((ch) => (
                  <div key={ch.key} style={css(CHANNEL_COLS + "border-top:1px solid #f4f4f1;")}>
                    <span style={css("display:flex; align-items:center; gap:9px; min-width:0;")}>
                      <span
                        style={css(
                          `width:22px; height:22px; border-radius:7px; background:${ch.bg}; color:${ch.fg}; display:flex; align-items:center; justify-content:center; flex:0 0 auto;`,
                        )}
                        dangerouslySetInnerHTML={{ __html: ch.icon }}
                      />
                      <span style={css("font-size:13px; color:#1a1a1a; font-weight:500;")}>{ch.label}</span>
                      <span style={css("font-size:11.5px; color:#a3a39d; white-space:nowrap;")}>
                        {ch.contacts} contact{ch.contacts === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                      {ch.touches}
                    </span>
                    <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                      {ch.replies}
                    </span>
                    <span style={css("text-align:right;")}>
                      <RatePill value={ch.replyRate} />
                    </span>
                    <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                      {ch.meetings}
                    </span>
                    <span style={css("text-align:right;")}>
                      <RatePill value={ch.meetingRate} />
                    </span>
                  </div>
                ))}
              </TableScroll>
            </Panel>

            {/* EVENT & COMMUNITY */}
            <Panel title="Event & community performance" hint="Loop 2 sources">
              {A.sources.length === 0 ? (
                <div style={css(PANEL_EMPTY)}>No Loop 2 contacts with a source in this view.</div>
              ) : (
                <TableScroll>
                  <div style={css(SOURCE_COLS + COL_LABEL + "padding-bottom:6px;")}>
                    <span>Source</span>
                    <span style={css("text-align:right;")}>Contacts</span>
                    <span style={css("text-align:right;")}>Touched</span>
                    <span style={css("text-align:right;")}>Replied</span>
                    <span style={css("text-align:right;")}>Meetings</span>
                    <span style={css("text-align:right;")}>Meeting rate</span>
                  </div>
                  {A.sources.map((s) => (
                    <div key={s.source} style={css(SOURCE_COLS + "border-top:1px solid #f4f4f1;")}>
                      <span
                        style={css(
                          "font-size:13px; color:#1a1a1a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                        )}
                        title={s.source}
                      >
                        {s.source}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {s.contacts}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {s.touched}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {s.replied}
                      </span>
                      <span style={css(MONO + "font-size:12.5px; text-align:right; color:#3a3a38;")}>
                        {s.meetings}
                      </span>
                      <span style={css("text-align:right;")}>
                        <RatePill value={s.meetingRate} />
                      </span>
                    </div>
                  ))}
                </TableScroll>
              )}
            </Panel>

            {/* ACTIVITY + WHY DEALS DIED */}
            <div
              style={css("display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:12px;")}
            >
              <Panel
                title={`Touchpoints · last ${A.chart.columns.length} days`}
                hint={A.chart.total ? `${A.chart.total} total` : undefined}
              >
                {A.chart.total === 0 ? (
                  <div style={css(PANEL_EMPTY)}>No touchpoints logged in the last {A.chart.columns.length} days.</div>
                ) : (
                  <>
                    <div style={css("display:flex; align-items:flex-end; gap:6px; height:150px; padding:14px 14px 0;")}>
                      {A.chart.columns.map((col, i) => (
                        <div
                          key={i}
                          title={`${col.label} · ${col.total} touchpoint${col.total === 1 ? "" : "s"}`}
                          style={css(
                            "flex:1 1 0; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:flex-end; gap:2px;",
                          )}
                        >
                          {col.total === 0 ? (
                            // A stub keeps the baseline reading continuously across quiet days.
                            <span style={css("width:100%; height:2px; border-radius:2px; background:#f2f2f0;")} />
                          ) : (
                            col.segments.map((seg) => (
                              <span
                                key={seg.key}
                                style={css(
                                  `width:100%; border-radius:2px; background:${seg.color}; height:${seg.height};`,
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
                      <span>{A.chart.startLabel}</span>
                      <span>{A.chart.endLabel}</span>
                    </div>
                    <div
                      style={css(
                        "display:flex; flex-wrap:wrap; gap:12px; padding:12px 14px; margin-top:10px; border-top:1px solid #f4f4f1;",
                      )}
                    >
                      {A.chart.legend.map((l) => (
                        <span
                          key={l.key}
                          style={css("display:flex; align-items:center; gap:6px; font-size:11.5px; color:#75756f;")}
                        >
                          <span
                            style={css(`width:8px; height:8px; border-radius:3px; background:${l.color};`)}
                          />
                          {l.label}
                          <span style={css(MONO + "color:#a3a39d;")}>{l.count}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </Panel>

              <Panel title="Why deals died" hint={A.deadTotal ? `${A.deadTotal} dead` : undefined}>
                {A.reasons.length === 0 ? (
                  <div style={css(PANEL_EMPTY)}>No contacts marked Dead in this view.</div>
                ) : (
                  <div style={css("padding:6px 0 10px;")}>
                    {A.reasons.map((r) => (
                      <BarRow
                        key={r.key}
                        color={r.color}
                        width={r.barWidth}
                        value={`${r.count} · ${r.pct}%`}
                        label={
                          <>
                            <span
                              style={css(`width:7px; height:7px; border-radius:4px; background:${r.color}; flex:0 0 auto;`)}
                            />
                            <span style={css("overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")}>
                              {r.key}
                            </span>
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* BY OWNER */}
            <Panel title="By owner">
              {A.owners.length === 0 ? (
                <div style={css(PANEL_EMPTY)}>No contacts in this view.</div>
              ) : (
                A.owners.map((o) => (
                  <div
                    key={o.key}
                    style={css(
                      "display:flex; align-items:center; gap:10px; padding:11px 14px; border-top:1px solid #f4f4f1;",
                    )}
                  >
                    <span
                      style={css(
                        `width:24px; height:24px; border-radius:7px; background:${o.hasAvatar ? o.color : "#e8e8e4"}; color:${o.hasAvatar ? "#fff" : "#a3a39d"}; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto;`,
                      )}
                    >
                      {o.hasAvatar ? o.initial : "?"}
                    </span>
                    <span style={css("min-width:0;")}>
                      <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>{o.label}</div>
                      <div style={css("font-size:11.5px; color:#9a9a95; margin-top:1px;")}>
                        {o.hasAvatar
                          ? `${o.meetings} meeting${o.meetings === 1 ? "" : "s"} · ${o.touchpoints} touchpoint${o.touchpoints === 1 ? "" : "s"}`
                          : "needs an owner"}
                      </div>
                    </span>
                    <span
                      style={css(MONO + "margin-left:auto; font-size:19px; font-weight:500; color:#1a1a1a;")}
                    >
                      {o.contacts}
                    </span>
                  </div>
                ))
              )}
            </Panel>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
