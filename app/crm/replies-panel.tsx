// The Replies tab on /analytics: Smartlead replies in a two-pane inbox.
//
// Left, one sentiment tab's threads (newest first); right, the open thread with a
// Respond box. Everything here talks to the /api/replies JSON routes with plain
// fetch() — not a useFetcher — so no click re-runs /analytics' loader, which reads
// the whole contact book (see app/lib/replies-api.server.ts).
//
// SMARTLEAD ONLY, and deliberately so: no channel badge, no channel filter. Every
// row is a reply to a Smartlead campaign. See migrations/0026.
//
// THREE RULES THIS FILE KEEPS:
//
//   * Nothing auto-opens. Opening a thread marks it read, so selecting the first
//     row on load would acknowledge a reply nobody looked at. "No thread
//     selected" is a real state with its own empty view.
//
//   * The reply draft is not page state. It lives in RespondBox (and a per-thread
//     ref so switching threads doesn't lose it) — the same rule CLAUDE.md states
//     for every text box: a keystroke must not re-render the list.
//
//   * A send is never silently retried. Smartlead sends are real emails. Each
//     draft carries one idempotency key; the server refuses a second use of it,
//     and the one case where the outcome is unknown (no answer from Smartlead)
//     is shown as exactly that, with the text kept, rather than as a failure the
//     rep would naturally press Send again on.
//
// No `Date` in render: every label ("today", "3d ago") arrives from the server.
// The panel only mounts once the tab is clicked, so none of this is SSR'd.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  avatarColor,
  type ReplyCounts,
  type ReplyListItem,
  type ReplyMessage,
  type ReplySentiment,
  type ReplyThreadDetail,
} from "./replies";
import { Box, css, IconCheck, IconReply, MONO } from "./ui";
import { LIMITS, safeMailto } from "../lib/validate";

/** How often an open tab re-reads counts, list and thread to pick up webhook deliveries. */
const POLL_MS = 30_000;

const CARD = "border:1px solid #ededea; border-radius:12px; background:#fff;";
const COL_LABEL =
  "font-size:11px; font-weight:500; color:#a3a39d; text-transform:uppercase; letter-spacing:0.05em;";
const BTN_SECONDARY =
  "display:inline-flex; align-items:center; gap:6px; white-space:nowrap; padding:7px 13px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer; background:#fff; border:1px solid #e2e2dd; color:#1a1a1a;";

const SENTIMENT_TONE: Record<ReplySentiment, { dot: string; label: string }> = {
  positive: { dot: "#22a06b", label: "Positive" },
  negative: { dot: "#d05252", label: "Negative" },
};

// The grid lives in a class rather than inline styles so the breakpoint can
// restack it: an inline grid-template-columns would outrank the rule below.
// A CONTAINER query, not a media query: the CRM's sidebar is a fixed rail, so the
// viewport width says little about how much room this panel actually has.
const PANEL_CSS = `
  .slcrm-replies-shell { container-type:inline-size; }
  .slcrm-replies-grid { display:grid; grid-template-columns:300px minmax(0,1fr); height:min(760px, calc(100vh - 230px)); min-height:460px; }
  .slcrm-replies-list { border-right:1px solid #f0f0ec; overflow-y:auto; overflow-x:hidden; min-height:0; }
  .slcrm-replies-detail { overflow-y:auto; min-height:0; }
  @container (max-width: 640px) {
    .slcrm-replies-grid { grid-template-columns:minmax(0,1fr); height:auto; min-height:0; }
    .slcrm-replies-list { border-right:none; border-bottom:1px solid #f0f0ec; max-height:340px; }
  }
`;

// ---------------------------------------------------------------------------
// Fetch plumbing
// ---------------------------------------------------------------------------

/**
 * `noAnswer`: the request may or may not have been processed — the connection
 * failed, or something other than this app's JSON came back (a platform 5xx
 * page). Only the send path treats that differently, and it matters there.
 */
type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; outcome?: string; noAnswer?: boolean };

async function api<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, error: "Couldn’t reach the server. Check your connection.", noAnswer: true };
  }
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    // Not this app's JSON. Only a redirect (to /login) or a 401 means the
    // session; anything else is an unexplained failure, and saying "reload" there
    // would lose the send key that makes a retry safe.
    if (res.redirected || res.status === 401) {
      return { ok: false, status: res.status, error: "Your session has expired. Reload the page to sign in again." };
    }
    return { ok: false, status: res.status, error: `The server didn’t answer properly (${res.status}).`, noAnswer: true };
  }
  if (!res.ok || parsed?.ok === false) {
    return {
      ok: false,
      status: res.status,
      error: typeof parsed?.error === "string" ? parsed.error : `Request failed (${res.status}).`,
      outcome: typeof parsed?.outcome === "string" ? parsed.outcome : undefined,
    };
  }
  return { ok: true, data: parsed as T };
}

/** A per-draft idempotency key. Only ever called from event handlers, never render. */
function newClientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.padEnd(24, "0");
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/** A message as shown: a server message, or an optimistic one still in flight. */
type ShownMessage = Omit<ReplyMessage, "delivery"> & { delivery: ReplyMessage["delivery"] | "sending" };

/**
 * `sentiment` is the tab the rows belong to and `listedAt` the server instant they
 * were read at. Mark all read sends that instant back, and refuses to run while
 * the list on screen is not the tab selected — mid-switch, the old tab's rows are
 * not what the button would clear.
 */
type ListState = {
  status: "loading" | "ready" | "error";
  sentiment: ReplySentiment;
  threads: ReplyListItem[];
  truncated: boolean;
  listedAt: string;
  error: string;
};
type DetailState = { status: "idle" | "loading" | "ready" | "error"; thread: ReplyThreadDetail | null; error: string };

/** The send state of one thread's Respond box, kept by the panel so it survives switching threads. */
type SendState = { error: string; note: string };

export function RepliesPanel({
  counts,
  onCounts,
  viewerName,
}: {
  counts: ReplyCounts;
  onCounts: (next: ReplyCounts | ((prev: ReplyCounts) => ReplyCounts)) => void;
  viewerName: string;
}) {
  const [sentiment, setSentiment] = useState<ReplySentiment>("positive");
  const [list, setList] = useState<ListState>({
    status: "loading",
    sentiment: "positive",
    threads: [],
    truncated: false,
    listedAt: "",
    error: "",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle", thread: null, error: "" });
  const [pending, setPending] = useState<Record<string, ShownMessage[]>>({});
  const [markAll, setMarkAll] = useState({ busy: false, error: "" });
  const [meeting, setMeeting] = useState({ busy: false, error: "", note: "" });
  const [sendState, setSendState] = useState<Record<string, SendState>>({});
  // Bumped to remount a thread's Respond box empty once its draft has gone out.
  const [draftEpoch, setDraftEpoch] = useState<Record<string, number>>({});

  // Per THREAD, not per Respond box: the box unmounts when the rep opens another
  // thread, and a key or draft that died with it would let a return visit send
  // the same words again under a fresh key while the first send is still out.
  const drafts = useRef(new Map<string, string>());
  const sendKeys = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  // The latest request per stream wins; an older answer arriving late is dropped.
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const sentimentRef = useRef(sentiment);
  sentimentRef.current = sentiment;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const refreshCounts = useCallback(async () => {
    const res = await api<ReplyCounts>("/api/replies/counts");
    if (res.ok) {
      const { positive, negative, unread, uncategorized } = res.data;
      onCounts({ positive, negative, unread, uncategorized });
    }
  }, [onCounts]);

  const loadList = useCallback(async (which: ReplySentiment, quiet: boolean) => {
    const seq = ++listSeq.current;
    // A loud load for a different tab drops the old rows at once rather than
    // leaving the previous tab's threads on screen under the new tab's pill.
    if (!quiet) {
      setList((l) => ({
        ...l,
        status: "loading",
        error: "",
        ...(l.sentiment === which ? {} : { sentiment: which, threads: [], truncated: false, listedAt: "" }),
      }));
    }
    const res = await api<{ threads: ReplyListItem[]; truncated: boolean; listedAt: string }>(
      `/api/replies?sentiment=${which}`,
    );
    if (seq !== listSeq.current) return;
    if (res.ok) {
      setList({
        status: "ready",
        sentiment: which,
        threads: res.data.threads,
        truncated: res.data.truncated,
        listedAt: res.data.listedAt,
        error: "",
      });
    }
    // A background refresh that fails keeps a loaded list on screen rather than
    // blanking it — but one that superseded the first load must still end it.
    else
      setList((l) =>
        quiet && l.status === "ready"
          ? l
          : { status: "error", sentiment: which, threads: [], truncated: false, listedAt: "", error: res.error },
      );
  }, []);

  const loadDetail = useCallback(async (id: string, quiet: boolean) => {
    const seq = ++detailSeq.current;
    if (!quiet) setDetail({ status: "loading", thread: null, error: "" });
    const res = await api<{ thread: ReplyThreadDetail }>(`/api/replies/${encodeURIComponent(id)}`);
    if (seq !== detailSeq.current || selectedRef.current !== id) return;
    if (res.ok) setDetail({ status: "ready", thread: res.data.thread, error: "" });
    else if (!quiet) setDetail({ status: "error", thread: null, error: res.error });
  }, []);

  // Tab change: reload the list and the counts it is labelled with.
  useEffect(() => {
    void loadList(sentiment, false);
    void refreshCounts();
  }, [sentiment, loadList, refreshCounts]);

  // Webhook deliveries arrive server-side; this is how an open tab sees them.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refreshCounts();
      void loadList(sentimentRef.current, true);
      if (selectedRef.current) void loadDetail(selectedRef.current, true);
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshCounts, loadList, loadDetail]);

  const patchRow = (id: string, patch: Partial<ReplyListItem>) =>
    setList((l) => ({ ...l, threads: l.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

  function openThread(item: ReplyListItem) {
    if (item.id === selectedId && detail.status !== "error") return;
    setSelectedId(item.id);
    selectedRef.current = item.id;
    setMeeting({ busy: false, error: "", note: "" });
    void loadDetail(item.id, false);
    if (!item.isRead) {
      // Optimistic: the dot and the pill drop now; the POST follows. A failure
      // re-reads the truth rather than guessing what to roll back to.
      patchRow(item.id, { isRead: true });
      onCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }));
      void api(`/api/replies/${encodeURIComponent(item.id)}/read`, {}).then((res) => {
        if (!res.ok) {
          patchRow(item.id, { isRead: false });
          void refreshCounts();
        }
      });
    }
  }

  const listIsCurrent = list.status === "ready" && list.sentiment === sentiment && Boolean(list.listedAt);

  async function markAllRead() {
    if (!listIsCurrent || markAll.busy || !list.threads.some((t) => !t.isRead)) return;
    setMarkAll({ busy: true, error: "" });
    // The server clears only replies that reached the CRM before this list was
    // read, so its answer — not a local guess — decides which rows go read.
    const res = await api<{ changed: number }>("/api/replies/mark-all-read", {
      sentiment: list.sentiment,
      before: list.listedAt,
    });
    setMarkAll({ busy: false, error: res.ok ? "" : res.error });
    void loadList(list.sentiment, true);
    void refreshCounts();
  }

  function finishDraft(threadId: string) {
    drafts.current.delete(threadId);
    sendKeys.current.delete(threadId);
    setDraftEpoch((e) => ({ ...e, [threadId]: (e[threadId] ?? 0) + 1 }));
  }

  function editDraft(threadId: string, text: string) {
    drafts.current.set(threadId, text);
    // New words are a new email: a key minted for the old text must not make the
    // server refuse this one as a duplicate.
    sendKeys.current.delete(threadId);
    setSendState((s) => (s[threadId]?.note || s[threadId]?.error ? { ...s, [threadId]: { error: "", note: "" } } : s));
  }

  async function sendReply(threadId: string, text: string) {
    // A ref, not `pending` state: a double-click lands before the re-render.
    if (inFlight.current.has(threadId)) return;
    inFlight.current.add(threadId);
    try {
      await sendReplyOnce(threadId, text);
    } finally {
      inFlight.current.delete(threadId);
    }
  }

  async function sendReplyOnce(threadId: string, text: string) {
    const clientKey = sendKeys.current.get(threadId) ?? newClientKey();
    sendKeys.current.set(threadId, clientKey);
    const report = (next: SendState) => setSendState((s) => ({ ...s, [threadId]: next }));
    report({ error: "", note: "" });

    const optimistic: ShownMessage = {
      id: `pending:${clientKey}`,
      direction: "SENT",
      body: text,
      sentAt: "",
      sentLabel: "just now",
      author: viewerName || "You",
      delivery: "sending",
    };
    setPending((p) => ({ ...p, [threadId]: [...(p[threadId] ?? []), optimistic] }));
    const res = await api<{ message: ReplyMessage | null }>(
      `/api/replies/${encodeURIComponent(threadId)}/send`,
      { text, clientKey },
    );
    setPending((p) => ({ ...p, [threadId]: (p[threadId] ?? []).filter((m) => m.id !== optimistic.id) }));

    if (res.ok) {
      const message = res.data.message;
      if (message) {
        setDetail((d) =>
          d.thread && d.thread.id === threadId && !d.thread.messages.some((m) => m.id === message.id)
            ? { ...d, thread: { ...d.thread, isRead: true, messages: [...d.thread.messages, message] } }
            : d,
        );
        // The thread moves to the top with the new message as its preview.
        setList((l) => {
          const row = l.threads.find((t) => t.id === threadId);
          if (!row) return l;
          const moved: ReplyListItem = {
            ...row,
            isRead: true,
            preview: message.body.replace(/\s+/g, " ").trim(),
            updatedAt: message.sentAt,
            updatedLabel: message.sentLabel,
          };
          return { ...l, threads: [moved, ...l.threads.filter((t) => t.id !== threadId)] };
        });
      }
      finishDraft(threadId);
      report({ error: "", note: "Sent." });
      void refreshCounts();
      return;
    }

    // The email went out (or already had): the draft must not survive to be sent twice.
    if (res.outcome === "duplicate" || res.outcome === "sent-unrecorded") {
      finishDraft(threadId);
      report({ error: res.error, note: "" });
      void loadDetail(threadId, true);
      return;
    }
    // The server says it cannot know. Keep the words; a deliberate second press
    // gets a new key, since the server will refuse this one for good.
    if (res.outcome === "unknown") {
      sendKeys.current.delete(threadId);
      report({ error: res.error, note: "" });
      void loadDetail(threadId, true);
      return;
    }
    // WE cannot know (connection dropped, or a non-JSON platform error): keep the
    // words AND the key. Pressing Send again is then safe by construction — the
    // server answers "already sent", "unknown", or sends it for the first time.
    if (res.noAnswer) {
      report({
        error: `${res.error} The reply may or may not have gone out. Pressing Send again is safe: the same draft can’t be sent twice.`,
        note: "",
      });
      return;
    }
    // A refusal: nothing was sent, and retrying with the same key is safe.
    report({ error: res.error, note: "" });
  }

  async function toggleMeeting(thread: ReplyThreadDetail) {
    if (meeting.busy) return;
    const next = !thread.meetingBooked;
    const apply = (booked: boolean) => {
      setDetail((d) =>
        d.thread && d.thread.id === thread.id
          ? {
              ...d,
              thread: {
                ...d.thread,
                meetingBooked: booked,
                tags: booked
                  ? [...d.thread.tags.filter((t) => t.kind !== "meeting"), { kind: "meeting", label: "Meeting booked" }]
                  : d.thread.tags.filter((t) => t.kind !== "meeting"),
              },
            }
          : d,
      );
      patchRow(thread.id, { meetingBooked: booked });
    };
    apply(next);
    setMeeting({ busy: true, error: "", note: "" });
    const res = await api<{ meetingBooked: boolean; promotedContact: string | null }>(
      `/api/replies/${encodeURIComponent(thread.id)}/meeting-booked`,
      { booked: next },
    );
    if (res.ok) {
      apply(res.data.meetingBooked);
      setMeeting({
        busy: false,
        error: "",
        note: res.data.promotedContact ? `${res.data.promotedContact} moved to Meeting booked in the CRM.` : "",
      });
    } else {
      apply(thread.meetingBooked);
      setMeeting({ busy: false, error: res.error, note: "" });
    }
  }

  const canMarkAll = listIsCurrent && !markAll.busy && list.threads.some((t) => !t.isRead);
  // Between a tab click and its load starting, the rows still belong to the old
  // tab, so they are not shown under the new one's pill.
  const showListLoading = list.sentiment !== sentiment || (list.status === "loading" && list.threads.length === 0);
  const tone = SENTIMENT_TONE[sentiment];

  return (
    <section className="slcrm-replies-shell" style={css(CARD + "overflow:hidden;")}>
      <style dangerouslySetInnerHTML={{ __html: PANEL_CSS }} />

      {/* HEADER: sentiment tabs + Mark all read */}
      <div
        style={css(
          "display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px; border-bottom:1px solid #f0f0ec;",
        )}
      >
        <div
          role="tablist"
          aria-label="Reply sentiment"
          style={css("display:inline-flex; gap:3px; padding:3px; border-radius:9px; background:#f2f2ee;")}
        >
          {(Object.keys(SENTIMENT_TONE) as ReplySentiment[]).map((key) => {
            const active = key === sentiment;
            return (
              <Box
                key={key}
                as="button"
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (active) return;
                  setSentiment(key);
                  setMarkAll({ busy: false, error: "" });
                }}
                style={css(
                  "display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border-radius:7px; font-size:12.5px; font-family:inherit; cursor:pointer; border:none;" +
                    (active
                      ? "background:#fff; color:#1a1a1a; font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,0.06);"
                      : "background:transparent; color:#75756f;"),
                )}
                hover={active ? undefined : css("color:#1a1a1a;")}
              >
                <span
                  style={css(`width:7px; height:7px; border-radius:4px; background:${SENTIMENT_TONE[key].dot};`)}
                />
                {SENTIMENT_TONE[key].label}
                <span style={css(MONO + "font-size:11.5px; color:#8a8a84;")}>{counts[key]}</span>
              </Box>
            );
          })}
        </div>

        <div style={css("margin-left:auto; display:flex; align-items:center; gap:10px;")}>
          {markAll.error && <span style={css("font-size:12px; color:#b42318;")}>{markAll.error}</span>}
          <Box
            as="button"
            type="button"
            onClick={markAllRead}
            disabled={!canMarkAll}
            style={css(BTN_SECONDARY + (canMarkAll ? "" : "opacity:0.5; cursor:default;"))}
            hover={canMarkAll ? css("background:#f7f7f4;") : undefined}
          >
            {markAll.busy ? "Marking…" : "Mark all read"}
          </Box>
        </div>
      </div>

      <div className="slcrm-replies-grid">
        {/* LEFT: thread list */}
        <div className="slcrm-replies-list">
          {showListLoading ? (
            <div style={css("padding:28px 16px; text-align:center; font-size:12.5px; color:#a3a39d;")}>Loading replies…</div>
          ) : list.status === "error" ? (
            <div style={css("padding:24px 16px; text-align:center; font-size:12.5px; color:#b42318;")}>
              {list.error}
              <div style={css("margin-top:10px;")}>
                <Box as="button" type="button" onClick={() => loadList(sentiment, false)} style={css(BTN_SECONDARY)}>
                  Try again
                </Box>
              </div>
            </div>
          ) : list.threads.length === 0 ? (
            <div style={css("padding:34px 18px; text-align:center;")}>
              <div style={css("font-size:13px; font-weight:500; color:#3a3a38;")}>
                No {tone.label.toLowerCase()} replies
              </div>
              <div style={css("font-size:12px; color:#a3a39d; margin-top:4px; line-height:1.5;")}>
                Replies appear here when Smartlead categorises a lead as {tone.label.toLowerCase()}.
              </div>
            </div>
          ) : (
            list.threads.map((t) => (
              <ThreadRow key={t.id} item={t} dot={tone.dot} selected={t.id === selectedId} onOpen={() => openThread(t)} />
            ))
          )}
          {(counts.uncategorized > 0 || list.truncated) && list.status !== "error" && (
            <div
              style={css(
                "padding:10px 14px; background:#fbfbfa; border-top:1px solid #f4f4f1; font-size:11.5px; color:#a3a39d; line-height:1.5;",
              )}
            >
              {list.truncated && <div>Showing the newest {list.threads.length}.</div>}
              {counts.uncategorized > 0 && (
                <div>
                  {counts.uncategorized} repl{counts.uncategorized === 1 ? "y is" : "ies are"} not yet categorised
                  positive or negative in Smartlead, so {counts.uncategorized === 1 ? "it's" : "they're"} in neither tab.
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT: the open thread */}
        <div className="slcrm-replies-detail">
          {!selectedId ? (
            <div
              style={css(
                "height:100%; min-height:260px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:#a3a39d; padding:24px; text-align:center;",
              )}
            >
              <IconReply size={20} />
              <div style={css("font-size:13px; color:#75756f; font-weight:500;")}>No reply selected</div>
              <div style={css("font-size:12px;")}>Pick a thread on the left to read it and respond.</div>
            </div>
          ) : detail.status === "loading" || (detail.status === "idle" && !detail.thread) ? (
            <div style={css("padding:28px 24px; font-size:12.5px; color:#a3a39d;")}>Loading thread…</div>
          ) : detail.status === "error" || !detail.thread ? (
            <div style={css("padding:28px 24px; font-size:12.5px; color:#b42318;")}>
              {detail.error || "Couldn’t load this thread."}
              <div style={css("margin-top:10px;")}>
                <Box as="button" type="button" onClick={() => loadDetail(selectedId, false)} style={css(BTN_SECONDARY)}>
                  Try again
                </Box>
              </div>
            </div>
          ) : (
            <ThreadView
              key={detail.thread.id}
              thread={detail.thread}
              pending={pending[detail.thread.id] ?? []}
              draftKey={`${detail.thread.id}:${draftEpoch[detail.thread.id] ?? 0}`}
              initialDraft={drafts.current.get(detail.thread.id) ?? ""}
              sendState={sendState[detail.thread.id] ?? { error: "", note: "" }}
              onDraft={(text) => editDraft(detail.thread!.id, text)}
              onSend={(text) => sendReply(detail.thread!.id, text)}
              onToggleMeeting={() => toggleMeeting(detail.thread!)}
              meeting={meeting}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

function ThreadRow({
  item,
  dot,
  selected,
  onOpen,
}: {
  item: ReplyListItem;
  dot: string;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <Box
      as="button"
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      style={css(
        "display:block; width:100%; text-align:left; font-family:inherit; cursor:pointer; padding:12px 14px 12px 12px; border:none; border-bottom:1px solid #f4f4f1; border-left:2px solid " +
          (selected ? "#1a1a1a" : "transparent") +
          "; background:" +
          (selected ? "#f6f6f3" : "#fff") +
          ";",
      )}
      hover={selected ? undefined : css("background:#fafaf8;")}
    >
      <span style={css("display:flex; align-items:center; gap:7px; min-width:0;")}>
        <span
          aria-label={item.isRead ? undefined : "Unread"}
          style={css(
            `width:7px; height:7px; border-radius:4px; flex:0 0 auto; background:${item.isRead ? "transparent" : dot};`,
          )}
        />
        <span
          style={css(
            "font-size:13px; color:#1a1a1a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;" +
              (item.isRead ? "font-weight:450;" : "font-weight:600;"),
          )}
        >
          {item.lead.name}
        </span>
        {!item.isRead && (
          <span
            style={css(
              "flex:0 0 auto; font-size:10.5px; font-weight:500; padding:1px 6px; border-radius:5px; background:#eef0fd; color:#4f46e5;",
            )}
          >
            New
          </span>
        )}
        <span style={css(MONO + "margin-left:auto; flex:0 0 auto; font-size:11px; color:#a3a39d;")}>
          {item.updatedLabel}
        </span>
      </span>
      <span style={css("display:flex; align-items:center; gap:7px; margin:5px 0 0 14px; min-width:0;")}>
        {item.lead.company && (
          <span
            style={css(
              "font-size:12px; color:#75756f; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;",
            )}
          >
            {item.lead.company}
          </span>
        )}
        <Avatar initials={item.lead.avatarInitials} colorKey={item.lead.name} size={18} />
        {item.meetingBooked && (
          <span style={css("flex:0 0 auto; color:#1f7a4d; display:inline-flex;")} title="Meeting booked">
            <IconCheck size={12} />
          </span>
        )}
      </span>
      <span
        style={css(
          "display:block; margin:5px 0 0 14px; font-size:12.5px; line-height:1.45; color:#575753; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;",
        )}
      >
        {item.preview || "(no text)"}
      </span>
    </Box>
  );
}

function Avatar({ initials, colorKey, size }: { initials: string; colorKey: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      style={css(
        `flex:0 0 auto; width:${size}px; height:${size}px; border-radius:${Math.round(size / 3.5)}px; background:${avatarColor(colorKey)}; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:${Math.round(size * 0.42)}px; font-weight:600; letter-spacing:0.01em;`,
      )}
    >
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Thread view
// ---------------------------------------------------------------------------

const TAG_TONE: Record<string, string> = {
  Positive: "background:#e4f3ea; color:#1f7a4d;",
  Negative: "background:#f4ecec; color:#9a5b5b;",
  Neutral: "background:#f2f2f0; color:#57575a;",
  Uncategorized: "background:#f2f2f0; color:#8a8a84;",
};

function ThreadView({
  thread,
  pending,
  draftKey,
  initialDraft,
  sendState,
  onDraft,
  onSend,
  onToggleMeeting,
  meeting,
}: {
  thread: ReplyThreadDetail;
  pending: ShownMessage[];
  draftKey: string;
  initialDraft: string;
  sendState: SendState;
  onDraft: (text: string) => void;
  onSend: (text: string) => Promise<void>;
  onToggleMeeting: () => void;
  meeting: { busy: boolean; error: string; note: string };
}) {
  const mailto = safeMailto(thread.lead.email);
  const subline = [thread.lead.title, thread.lead.company].filter(Boolean).join(" · ");
  const messages: ShownMessage[] = [...thread.messages, ...pending];

  return (
    <div style={css("padding:20px 24px 28px; display:flex; flex-direction:column; gap:14px; max-width:760px;")}>
      {/* Lead header */}
      <div style={css("display:flex; align-items:flex-start; gap:11px;")}>
        <Avatar initials={thread.lead.avatarInitials} colorKey={thread.lead.name} size={28} />
        <div style={css("min-width:0;")}>
          <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.01em; color:#1a1a1a; line-height:1.3;")}>
            {thread.lead.name}
          </div>
          {subline && <div style={css("font-size:12.5px; color:#75756f; margin-top:2px;")}>{subline}</div>}
          {mailto ? (
            <a href={mailto} style={css("display:inline-block; font-size:12.5px; color:#2f6ea8; margin-top:2px; text-decoration:none;")}>
              {thread.lead.email}
            </a>
          ) : (
            <div style={css("font-size:12.5px; color:#75756f; margin-top:2px;")}>{thread.lead.email}</div>
          )}
          {thread.contact && (
            <div style={css("font-size:11.5px; color:#a3a39d; margin-top:4px;")}>
              In the CRM as {thread.contact.name} · {thread.contact.status}
            </div>
          )}
        </div>
      </div>

      {/* Tags */}
      <div style={css("display:flex; flex-wrap:wrap; gap:6px;")}>
        {thread.tags.map((tag) =>
          tag.kind === "meeting" ? (
            <span
              key="meeting"
              style={css(
                "display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:6px; font-size:11.5px; font-weight:500; background:#e4f3ea; color:#1f7a4d;",
              )}
            >
              <span style={css("width:6px; height:6px; border-radius:3px; background:#22a06b;")} />
              {tag.label}
            </span>
          ) : (
            <span
              key={`s-${tag.label}`}
              title={thread.lead.category ? `Smartlead category: ${thread.lead.category}` : undefined}
              style={css(
                "display:inline-flex; align-items:center; padding:3px 9px; border-radius:6px; font-size:11.5px; font-weight:500;" +
                  (TAG_TONE[tag.label] ?? TAG_TONE.Neutral),
              )}
            >
              {tag.label}
            </span>
          ),
        )}
      </div>

      {/* Messages */}
      {messages.length === 0 ? (
        <div style={css(CARD + "padding:16px; font-size:12.5px; color:#a3a39d;")}>No message text was delivered for this thread.</div>
      ) : (
        messages.map((m) => (
          <div
            key={m.id}
            style={css(
              CARD +
                "padding:14px 16px;" +
                (m.direction === "SENT" ? "background:#fbfbfa;" : "") +
                (m.delivery === "sending" ? "opacity:0.7;" : ""),
            )}
          >
            <div style={css("display:flex; align-items:baseline; gap:10px;")}>
              <span style={css("font-size:12.5px; font-weight:500; color:#3a3a38;")}>{m.author}</span>
              <span style={css(MONO + "margin-left:auto; font-size:11px; color:#a3a39d;")}>{m.sentLabel}</span>
            </div>
            <div
              style={css(
                "margin-top:8px; font-size:13.5px; line-height:1.6; color:#1a1a1a; white-space:pre-wrap; overflow-wrap:anywhere;",
              )}
            >
              {m.body || "(no text)"}
            </div>
            {m.delivery !== "confirmed" && (
              <div
                style={css(
                  "margin-top:8px; font-size:11.5px;" + (m.delivery === "unknown" ? "color:#8a6d1f;" : "color:#a3a39d;"),
                )}
              >
                {m.delivery === "sending"
                  ? "Sending…"
                  : m.delivery === "unknown"
                    ? "Outcome unknown · this send never finished, so it may or may not have gone out. Check Smartlead before sending it again."
                    : "Sent from the CRM · waiting for Smartlead to confirm"}
              </div>
            )}
          </div>
        ))
      )}

      <RespondBox
        key={draftKey}
        threadId={thread.id}
        initialDraft={initialDraft}
        sending={pending.some((m) => m.delivery === "sending")}
        sendState={sendState}
        canReply={thread.canReply}
        meetingBooked={thread.meetingBooked}
        meeting={meeting}
        onDraft={onDraft}
        onSend={onSend}
        onToggleMeeting={onToggleMeeting}
      />
    </div>
  );
}

/**
 * The Respond card. Owns only the text being typed (see the file header). The
 * send key, the in-flight flag and the outcome live in the panel, per thread, so
 * opening another thread mid-send and coming back cannot re-enable Send for the
 * same words under a new key; the panel remounts this box (`key`) to clear it.
 */
function RespondBox({
  threadId,
  initialDraft,
  sending,
  sendState,
  canReply,
  meetingBooked,
  meeting,
  onDraft,
  onSend,
  onToggleMeeting,
}: {
  threadId: string;
  initialDraft: string;
  sending: boolean;
  sendState: SendState;
  canReply: boolean;
  meetingBooked: boolean;
  meeting: { busy: boolean; error: string; note: string };
  onDraft: (text: string) => void;
  onSend: (text: string) => Promise<void>;
  onToggleMeeting: () => void;
}) {
  const [text, setText] = useState(initialDraft);
  const sendDisabled = !text.trim() || sending || !canReply;
  const { error, note: sentNote } = sendState;

  function submit() {
    if (sendDisabled) return;
    void onSend(text.trim());
  }

  return (
    <div style={css(CARD + "padding:14px 16px; display:flex; flex-direction:column; gap:10px;")}>
      <label htmlFor={`reply-${threadId}`} style={css(COL_LABEL)}>
        Respond
      </label>
      <Box
        as="textarea"
        id={`reply-${threadId}`}
        value={text}
        onChange={(e: any) => {
          const next = e.target.value as string;
          setText(next);
          onDraft(next);
        }}
        placeholder="Write your response…"
        rows={5}
        maxLength={LIMITS.reply}
        disabled={sending}
        style={css(
          // Longhand border: the focus style swaps only the colour, and React
          // warns when a re-render removes a longhand under a shorthand.
          "width:100%; resize:vertical; min-height:96px; padding:10px 12px; border-radius:9px; border-width:1px; border-style:solid; border-color:#e2e2dd; font-family:inherit; font-size:13.5px; line-height:1.55; color:#1a1a1a; background:#fff; outline:none;",
        )}
        focus={css("border-color:#a9a9a3;")}
      />

      {!canReply && (
        <div style={css("font-size:12px; color:#8a6d1f;")}>
          Smartlead hasn’t sent the CRM enough about this thread to reply to it from here. Answer it from Smartlead’s
          inbox.
        </div>
      )}
      {error && (
        <div role="alert" style={css("font-size:12.5px; color:#b42318; line-height:1.5;")}>
          {error}
        </div>
      )}
      {meeting.error && (
        <div role="alert" style={css("font-size:12.5px; color:#b42318;")}>
          {meeting.error}
        </div>
      )}
      {(sentNote || meeting.note) && (
        <div style={css("font-size:12px; color:#1f7a4d;")}>{[sentNote, meeting.note].filter(Boolean).join(" ")}</div>
      )}

      <div style={css("display:flex; flex-wrap:wrap; align-items:center; gap:8px;")}>
        <Box
          as="button"
          type="button"
          onClick={submit}
          disabled={sendDisabled}
          aria-busy={sending}
          style={css(
            "display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; font-family:inherit; border:1px solid #1a1a1a; background:#1a1a1a; color:#fff;" +
              (sendDisabled ? "opacity:0.45; cursor:default;" : "cursor:pointer;"),
          )}
          hover={sendDisabled ? undefined : css("background:#333; border-color:#333;")}
        >
          {sending ? "Sending…" : "Send email"}
        </Box>
        <Box
          as="button"
          type="button"
          onClick={onToggleMeeting}
          disabled={meeting.busy}
          aria-pressed={meetingBooked}
          style={css(
            "display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; font-size:13px; font-family:inherit;" +
              (meetingBooked
                ? "background:#e4f3ea; border:1px solid #bfe3cd; color:#1f7a4d; font-weight:500;"
                : "background:#fff; border:1px solid #e2e2dd; color:#2f5f45;") +
              (meeting.busy ? "opacity:0.6; cursor:default;" : "cursor:pointer;"),
          )}
          hover={meeting.busy ? undefined : css(meetingBooked ? "background:#d8eee1;" : "background:#f7f7f4;")}
        >
          {meetingBooked && <IconCheck size={13} />}
          {meetingBooked ? "Meeting booked" : "Mark meeting booked"}
        </Box>
      </div>
    </div>
  );
}
