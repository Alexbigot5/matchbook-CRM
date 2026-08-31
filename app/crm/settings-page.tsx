// The /settings UI.
//
// Same idiom as ./smartlead-page.tsx and ./templates-page.tsx: one client
// component, a `useState` God object holding UI state only (patched through
// `patch()`), a single `useFetcher` with a hidden `intent` field, and one
// `useEffect` folding the action's result into a banner. No optimistic UI —
// React Router revalidates the loader.
//
// Nothing here calls `Date`. The "Jul 20" labels and the reply count arrive
// precomputed from the loader, for the usual SSR/hydration reason.
//
// TWO ACCOUNT LISTS, AND THE PAGE ALWAYS SAYS WHICH ONE IT IS SHOWING. Before
// Refresh is pressed it renders `storedAccounts` — the sync's own bookkeeping,
// which knows when each account was last read but nothing about whether it still
// works. After Refresh it renders the live list, which carries Unipile's health
// status. A page that blurred the two would show "Connected" for a LinkedIn
// session that expired overnight, which is the single thing an operator most
// needs told the truth about. Same distinction /smartlead's SENDERS section
// draws between "not loaded" and "none assigned".

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { AccountView } from "../routes/settings";
import type { Contact, Viewer } from "./data";
import { CH } from "./data";
import { Sidebar, buildOwnerTabs, buildViewTabs } from "./sidebar";
import { Box, GLOBAL_CSS, IconReply, IconWarn, MONO, css } from "./ui";

/** One connected account as the last sync recorded it. Mirrors UnipileSyncState. */
export type StoredAccount = {
  accountId: string;
  provider: string;
  displayName: string;
  lastSyncedAt: string | null;
  lastSyncedLabel: string | null;
  lastResult: string | null;
};

export type UnipileConfig = {
  hasKey: boolean;
  /** The normalised host, or null when unset/unusable. Never the key. */
  dsn: string | null;
  /** True when something was configured but didn't survive normalisation. */
  dsnRaw: boolean;
  firstSyncDays: number;
};

// Mirrors the action's return type. Not imported as a value — the same hand-kept
// arrangement smartlead-page.tsx uses.
type ActionResult =
  | { ok: true; message?: string; accounts?: AccountView[]; connectUrl?: string }
  | { ok: false; error: string };

const CARD = "background:#fff; border:1px solid #ededea; border-radius:14px; overflow:hidden;";
const SECTION = "padding:14px 18px; border-top:1px solid #f2f2ef;";
const HEAD = "padding:14px 18px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em;";
const GHOST =
  "padding:6px 11px; border:1px solid #e2e2dd; background:#fff; border-radius:8px; font-size:12px; color:#3a3a38; cursor:pointer; font-family:inherit;";
const PRIMARY =
  "padding:6px 12px; border:1px solid #1a1a1a; background:#1a1a1a; border-radius:8px; font-size:12px; color:#fff; cursor:pointer; font-family:inherit;";
const DANGER =
  "padding:6px 11px; border:1px solid #e7c3c3; background:#fff; border-radius:8px; font-size:12px; color:#a33a3a; cursor:pointer; font-family:inherit;";
const MUTED = "font-size:11.5px; color:#9a9a95;";
const BODY = "font-size:12.5px; color:#57575a; line-height:1.55;";

/** Provider label + chip colours, keyed on the channel the sync reads it as. */
const CHANNEL_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  email: { label: "Email", bg: CH.email.bg, fg: CH.email.fg },
  linkedin: { label: "LinkedIn", bg: CH.linkedin.bg, fg: CH.linkedin.fg },
};

type State = {
  view: string;
  owner: string;
  banner: { ok: boolean; text: string } | null;
  /** The live account list, once Refresh has returned one. Null means "not loaded". */
  accounts: AccountView[] | null;
  /**
   * Which destructive button is awaiting a second press, by a key naming the
   * exact target ("disconnect:<id>", "signout").
   *
   * An inline two-step rather than a modal, deliberately. The overlay shells on
   * / and /templates exist because those confirmations summarise a bulk
   * selection the row itself cannot show; here the target IS the row being
   * pressed, so a dialog restating it adds a layer without adding information.
   * One key, not a boolean, so opening a second confirmation closes the first —
   * two rows both asking "are you sure?" is how the wrong one gets clicked.
   */
  confirming: string | null;
};

export function SettingsPage({
  viewer,
  email,
  contacts,
  unreadReplies,
  storedAccounts,
  unipile,
}: {
  viewer: Viewer;
  email: string;
  contacts: Contact[];
  unreadReplies: number;
  storedAccounts: StoredAccount[];
  unipile: UnipileConfig;
}) {
  const [S, setS] = useState<State>({
    view: "all",
    owner: "all",
    banner: null,
    accounts: null,
    confirming: null,
  });
  const patch = (p: Partial<State>) => setS((s) => ({ ...s, ...p }));

  const fetcher = useFetcher<ActionResult>();
  const pending = fetcher.state !== "idle";

  // One effect folds every result into the banner, and is also where a minted
  // connect link is acted on.
  //
  // The navigation happens HERE rather than from the click handler because the
  // URL does not exist until the server has minted it — the button starts a
  // round trip, and this is the only place that sees it land. Assigning
  // `window.location` is an ordinary navigation, which is what gets past the
  // `form-action 'self'` CSP that would silently block a 302 out of the action;
  // routes/settings.tsx's ActionResult docblock has the detail.
  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== "idle") return;

    if (data.ok && data.connectUrl) {
      window.location.href = data.connectUrl;
      return;
    }
    if (data.ok) {
      patch({
        banner: data.message ? { ok: true, text: data.message } : null,
        // `accounts` is only present on a fetchAccounts result, so this leaves a
        // previously loaded list alone after an unrelated write rather than
        // blanking it back to "not loaded".
        ...(data.accounts ? { accounts: data.accounts } : {}),
        confirming: null,
      });
    } else {
      patch({ banner: { ok: false, text: data.error }, confirming: null });
    }
  }, [fetcher.data, fetcher.state]);

  const submit = (fields: Record<string, string>) => {
    patch({ banner: null });
    fetcher.submit(fields, { method: "post" });
  };

  const configured = unipile.hasKey && Boolean(unipile.dsn);

  // The live list when it has been loaded, otherwise the sync's own record of
  // what it last read. `live` is what decides which captions the section shows.
  const live = S.accounts !== null;
  const rows: {
    id: string;
    name: string;
    provider: string;
    channel: string | null;
    health: { ok: boolean; status: string } | null;
    lastSyncedLabel: string | null;
    lastResult: string | null;
  }[] = live
    ? S.accounts!.map((a) => ({
        id: a.id,
        name: a.name || a.id,
        provider: a.provider,
        channel: a.channel,
        health: { ok: a.ok, status: a.status },
        lastSyncedLabel: a.lastSyncedLabel,
        lastResult: a.lastResult,
      }))
    : storedAccounts.map((a) => ({
        id: a.accountId,
        name: a.displayName || a.accountId,
        provider: a.provider,
        // Derived from the stored provider rather than re-asserted: the same
        // mapping the sync used when it wrote the row.
        channel:
          a.provider === "LINKEDIN"
            ? "linkedin"
            : ["MAIL", "GOOGLE_OAUTH", "OUTLOOK", "ICLOUD", "EXCHANGE"].includes(a.provider)
              ? "email"
              : null,
        health: null,
        lastSyncedLabel: a.lastSyncedLabel,
        lastResult: a.lastResult,
      }));

  return (
    <div
      style={css(
        "display:flex; height:100vh; background:#f7f7f5; color:#1c1c1a; font-family:Geist,ui-sans-serif,system-ui,sans-serif; overflow:hidden;",
      )}
    >
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <Sidebar
        nav="settings"
        viewTabs={buildViewTabs(contacts, S.view, (key) => patch({ view: key }))}
        ownerTabs={buildOwnerTabs(contacts, S.owner, (key) => patch({ owner: key }))}
        viewer={viewer}
        ownerNote="Settings aren’t filtered; these are contact counts."
      />

      <div style={css("flex:1; display:flex; flex-direction:column; min-width:0;")}>
        <div
          style={css(
            "display:flex; align-items:center; padding:16px 24px; border-bottom:1px solid #ededea; background:#fff;",
          )}
        >
          <div>
            <div style={css("font-size:15px; font-weight:600; letter-spacing:-0.01em;")}>
              Settings
            </div>
            <div style={css(MUTED + "margin-top:2px;")}>
              Your account, and the inbox connection that finds replies.
            </div>
          </div>
        </div>

        <div style={css("flex:1; overflow-y:auto; padding:20px 24px 48px;")}>
          <div style={css("max-width:820px; display:flex; flex-direction:column; gap:16px;")}>
            {S.banner && (
              <div
                style={css(
                  `padding:10px 13px; border-radius:10px; font-size:12.5px; line-height:1.5; border:1px solid ${
                    S.banner.ok ? "#cfe3d2" : "#e7c3c3"
                  }; background:${S.banner.ok ? "#f3f9f4" : "#fdf4f4"}; color:${
                    S.banner.ok ? "#2c6b3f" : "#a33a3a"
                  };`,
                )}
              >
                {S.banner.text}
              </div>
            )}

            {/* ---------------------------------------------------------- */}
            {/* Account                                                     */}
            {/* ---------------------------------------------------------- */}
            <div style={css(CARD)}>
              <div style={css(HEAD)}>
                <span
                  style={css(
                    `width:34px; height:34px; border-radius:9px; background:${viewer.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; flex:0 0 auto;`,
                  )}
                >
                  {viewer.initial}
                </span>
                <span style={css("display:flex; flex-direction:column; gap:2px; min-width:0;")}>
                  <span style={css("font-size:14px; font-weight:600;")}>{viewer.name}</span>
                  <span style={css(MONO + "font-size:11.5px; color:#75756f;")}>{email}</span>
                </span>
              </div>

              <div style={css(SECTION)}>
                <div style={css(COL_LABEL + "margin-bottom:6px;")}>Sign-in</div>
                <div style={css(BODY)}>
                  Sign-in is by emailed magic link, so there is no password to change here.
                  Access is limited to a fixed list of addresses; adding or removing someone is
                  a code change, and a removal takes effect on their next request even if they
                  are already signed in.
                </div>
              </div>

              <div style={css(SECTION)}>
                <div style={css(COL_LABEL + "margin-bottom:6px;")}>Sign out everywhere</div>
                <div style={css(BODY + "margin-bottom:10px;")}>
                  Ends every session on your account — other browsers, other devices, and{" "}
                  <strong style={css("font-weight:600; color:#3a3a38;")}>this one too</strong>.
                  Use it if a laptop went missing. You will be sent back to the sign-in page and
                  will need a fresh link.
                </div>
                {S.confirming === "signout" ? (
                  <div style={css("display:flex; align-items:center; gap:8px; flex-wrap:wrap;")}>
                    <span style={css("font-size:12.5px; color:#a33a3a;")}>
                      Sign out of every device, including this one?
                    </span>
                    <Box
                      as="button"
                      disabled={pending}
                      onClick={() => submit({ intent: "signOutEverywhere" })}
                      style={css(DANGER)}
                      hover={css("background:#fdf4f4;")}
                    >
                      Yes, sign out everywhere
                    </Box>
                    <Box
                      as="button"
                      onClick={() => patch({ confirming: null })}
                      style={css(GHOST)}
                      hover={css("background:#f6f6f3;")}
                    >
                      Cancel
                    </Box>
                  </div>
                ) : (
                  <Box
                    as="button"
                    onClick={() => patch({ confirming: "signout" })}
                    style={css(DANGER)}
                    hover={css("background:#fdf4f4;")}
                  >
                    Sign out everywhere
                  </Box>
                )}
              </div>
            </div>

            {/* ---------------------------------------------------------- */}
            {/* Replies                                                     */}
            {/* ---------------------------------------------------------- */}
            <div style={css(CARD)}>
              <div style={css(HEAD)}>
                <IconReply size={15} style={css("color:#4457c9;")} />
                <span style={css("font-size:14px; font-weight:600;")}>Replies</span>
                <span style={css(MONO + "font-size:11.5px; color:#a3a39d;")}>
                  {unreadReplies} unread
                </span>
                <span style={css("flex:1;")} />
                <Box
                  as="button"
                  disabled={pending || !configured}
                  onClick={() => submit({ intent: "syncReplies" })}
                  style={css(PRIMARY + (configured ? "" : "opacity:0.5; cursor:default;"))}
                  hover={configured ? css("background:#333;") : undefined}
                >
                  {pending ? "Working…" : "Sync replies"}
                </Box>
                {unreadReplies > 0 && (
                  <Box
                    as="button"
                    disabled={pending}
                    onClick={() => submit({ intent: "markAllRepliesRead" })}
                    style={css(GHOST)}
                    hover={css("background:#f6f6f3;")}
                  >
                    Mark all read
                  </Box>
                )}
              </div>
              <div style={css(SECTION)}>
                <div style={css(BODY)}>
                  A sync reads each connected account for messages newer than the last one, works
                  out which contact they came from, and files them: a card on the contacts page,
                  a touchpoint on the timeline, and a move to{" "}
                  <strong style={css("font-weight:600; color:#3a3a38;")}>Replied</strong> for
                  anyone still sitting at New or Contacted. Nothing further along the pipeline is
                  moved backwards.
                </div>
                <div style={css(BODY + "margin-top:8px;")}>
                  Replies from people who aren’t in the CRM are counted and skipped — the sync
                  says how many, so a quiet inbox is distinguishable from a matching problem.
                  The first sync of an account reads the last {unipile.firstSyncDays} days.
                </div>
              </div>
            </div>

            {/* ---------------------------------------------------------- */}
            {/* Unipile                                                     */}
            {/* ---------------------------------------------------------- */}
            <div style={css(CARD)}>
              <div style={css(HEAD)}>
                <span style={css("font-size:14px; font-weight:600;")}>Unipile</span>
                <span
                  style={css(
                    `display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border-radius:999px; font-size:11px; font-weight:500; background:${
                      configured ? "#eaf4ec" : "#fdf4f4"
                    }; color:${configured ? "#2c6b3f" : "#a33a3a"};`,
                  )}
                >
                  <span
                    style={css(
                      `width:6px; height:6px; border-radius:4px; background:${configured ? "#3f8f5a" : "#c05252"};`,
                    )}
                  />
                  {configured ? "Configured" : "Not configured"}
                </span>
                <span style={css("flex:1;")} />
                {configured && (
                  <Box
                    as="button"
                    disabled={pending}
                    onClick={() => submit({ intent: "fetchAccounts" })}
                    style={css(GHOST)}
                    hover={css("background:#f6f6f3;")}
                  >
                    {live ? "Refresh" : "Load accounts"}
                  </Box>
                )}
              </div>

              <div style={css(SECTION)}>
                <div style={css(BODY)}>
                  Unipile is the one connection behind both reply channels: it holds the
                  credentials for the team’s mailboxes and LinkedIn, and this CRM only ever reads
                  through it. Nothing is sent from here.
                </div>

                {!configured && (
                  <div
                    style={css(
                      "margin-top:10px; padding:10px 12px; border:1px solid #f0e0c8; background:#fffaf2; border-radius:10px; font-size:12.5px; color:#8a6520; line-height:1.55;",
                    )}
                  >
                    <div style={css("display:flex; align-items:center; gap:7px; margin-bottom:5px;")}>
                      <IconWarn size={13} />
                      <strong style={css("font-weight:600;")}>Two settings are needed.</strong>
                    </div>
                    {!unipile.hasKey && (
                      <div>
                        <code>UNIPILE_API_KEY</code> is unset — <code>wrangler secret put
                        UNIPILE_API_KEY</code>.
                      </div>
                    )}
                    {!unipile.dsn && (
                      <div>
                        <code>UNIPILE_DSN</code>{" "}
                        {unipile.dsnRaw
                          ? "is set but isn’t an https URL. It looks like https://api8.unipile.com:13851."
                          : "is unset. It is the API host on your Unipile dashboard, e.g. https://api8.unipile.com:13851, and goes in wrangler.toml [vars]."}
                      </div>
                    )}
                  </div>
                )}

                {unipile.dsn && (
                  <div style={css(MUTED + "margin-top:10px;")}>
                    Talking to <span style={css(MONO)}>{unipile.dsn}</span>
                  </div>
                )}
              </div>

              {configured && (
                <div style={css(SECTION)}>
                  <div style={css(COL_LABEL + "margin-bottom:8px;")}>Connect an account</div>
                  <div style={css(BODY + "margin-bottom:10px;")}>
                    Opens Unipile’s own sign-in page in this tab. Passwords, Google consent and
                    LinkedIn’s 2FA all happen there — no credential is ever typed into this CRM
                    or stored by it. You will land back here when it finishes.
                  </div>
                  <div style={css("display:flex; gap:8px; flex-wrap:wrap;")}>
                    <Box
                      as="button"
                      disabled={pending}
                      onClick={() => submit({ intent: "connect", kind: "mailbox" })}
                      style={css(PRIMARY)}
                      hover={css("background:#333;")}
                    >
                      Connect a mailbox
                    </Box>
                    <Box
                      as="button"
                      disabled={pending}
                      onClick={() => submit({ intent: "connect", kind: "linkedin" })}
                      style={css(GHOST)}
                      hover={css("background:#f6f6f3;")}
                    >
                      Connect LinkedIn
                    </Box>
                  </div>
                </div>
              )}

              <div style={css(SECTION)}>
                <div
                  style={css(
                    "display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:8px;",
                  )}
                >
                  <span style={css(COL_LABEL)}>Connected accounts</span>
                  <span style={css(MUTED)}>
                    {live
                      ? "Live from Unipile"
                      : rows.length
                        ? "From the last sync — press Load accounts to check them"
                        : ""}
                  </span>
                </div>

                {rows.length === 0 ? (
                  <div style={css(MUTED + "line-height:1.55;")}>
                    {live
                      ? "Nothing is connected to Unipile yet."
                      : configured
                        ? "Nothing has been synced yet. Press Load accounts to see what is connected."
                        : "Nothing to show until Unipile is configured."}
                  </div>
                ) : (
                  <div style={css("display:flex; flex-direction:column; gap:8px;")}>
                    {rows.map((row) => {
                      const chip = row.channel ? CHANNEL_CHIP[row.channel] : null;
                      const confirmKey = `disconnect:${row.id}`;
                      return (
                        <div
                          key={row.id}
                          style={css(
                            "border:1px solid #ededea; border-radius:11px; padding:11px 13px; display:flex; flex-direction:column; gap:8px;",
                          )}
                        >
                          <div
                            style={css(
                              "display:flex; align-items:center; gap:9px; flex-wrap:wrap;",
                            )}
                          >
                            {chip ? (
                              <span
                                style={css(
                                  `padding:2px 7px; border-radius:6px; font-size:10.5px; font-weight:500; background:${chip.bg}; color:${chip.fg};`,
                                )}
                              >
                                {chip.label}
                              </span>
                            ) : (
                              <span
                                title="Connected to Unipile, but this CRM only reads email and LinkedIn."
                                style={css(
                                  "padding:2px 7px; border-radius:6px; font-size:10.5px; font-weight:500; background:#f2f2f0; color:#8a8a84;",
                                )}
                              >
                                Not read here
                              </span>
                            )}
                            <span
                              style={css(
                                "font-size:13px; font-weight:500; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
                              )}
                            >
                              {row.name}
                            </span>
                            <span style={css(MONO + "font-size:10.5px; color:#a3a39d;")}>
                              {row.provider}
                            </span>
                            {/* Health is only shown on the live list. A stored row
                                knows nothing about it, and an absent dot is
                                honest where a green one would not be. */}
                            {row.health &&
                              (() => {
                                // Three states, not two. UNKNOWN means Unipile
                                // reported no source status at all — which is not
                                // the same as a broken account, and colouring it
                                // like one would send someone to re-authenticate a
                                // mailbox that is working fine.
                                const unknown = row.health.status === "UNKNOWN";
                                const colour = row.health.ok
                                  ? "#3f8f5a"
                                  : unknown
                                    ? "#a3a39d"
                                    : "#c2410c";
                                return (
                                  <span
                                    style={css(
                                      `display:inline-flex; align-items:center; gap:5px; font-size:11.5px; color:${colour};`,
                                    )}
                                  >
                                    <span
                                      style={css(
                                        `width:6px; height:6px; border-radius:4px; background:${colour};`,
                                      )}
                                    />
                                    {row.health.ok
                                      ? "Connected"
                                      : unknown
                                        ? "Status not reported"
                                        : row.health.status}
                                  </span>
                                );
                              })()}
                            <span style={css("flex:1;")} />
                            <span style={css(MUTED)}>
                              {row.lastSyncedLabel
                                ? `Last synced ${row.lastSyncedLabel}`
                                : "Never synced"}
                            </span>
                          </div>

                          {row.lastResult && (
                            <div style={css(MUTED + "line-height:1.5;")}>{row.lastResult}</div>
                          )}

                          {/* Only for a status Unipile actually reported as bad.
                              UNKNOWN is excluded: telling someone their replies
                              aren't arriving because a field was absent is the
                              kind of false alarm that gets a page ignored. */}
                          {row.health && !row.health.ok && row.health.status !== "UNKNOWN" && (
                            <div style={css("font-size:11.5px; color:#c2410c; line-height:1.5;")}>
                              {row.health.status === "CREDENTIALS"
                                ? "This account needs signing in again. Reconnect it from Unipile, then press Refresh."
                                : "Unipile can’t read this account right now, so its replies aren’t arriving."}
                            </div>
                          )}

                          <div style={css("display:flex; gap:8px; flex-wrap:wrap;")}>
                            {S.confirming === confirmKey ? (
                              <>
                                <span style={css("font-size:12px; color:#a33a3a;")}>
                                  Disconnect this account? Replies already synced are kept.
                                </span>
                                <Box
                                  as="button"
                                  disabled={pending}
                                  onClick={() =>
                                    submit({ intent: "disconnect", accountId: row.id })
                                  }
                                  style={css(DANGER)}
                                  hover={css("background:#fdf4f4;")}
                                >
                                  Yes, disconnect
                                </Box>
                                <Box
                                  as="button"
                                  onClick={() => patch({ confirming: null })}
                                  style={css(GHOST)}
                                  hover={css("background:#f6f6f3;")}
                                >
                                  Cancel
                                </Box>
                              </>
                            ) : (
                              <>
                                {row.lastSyncedLabel && (
                                  <Box
                                    as="button"
                                    disabled={pending}
                                    title={`Clear this account's watermark so the next sync re-reads the last ${unipile.firstSyncDays} days.`}
                                    onClick={() =>
                                      submit({ intent: "resetWatermark", accountId: row.id })
                                    }
                                    style={css(GHOST)}
                                    hover={css("background:#f6f6f3;")}
                                  >
                                    Re-read last {unipile.firstSyncDays} days
                                  </Box>
                                )}
                                <Box
                                  as="button"
                                  onClick={() => patch({ confirming: confirmKey })}
                                  style={css(GHOST)}
                                  hover={css("background:#f6f6f3;")}
                                >
                                  Disconnect
                                </Box>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
