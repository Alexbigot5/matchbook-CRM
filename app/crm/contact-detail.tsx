// Shared contact UI: the detail slide-over, the two modals it triggers, and the
// small presentational bits both contact views render. Used by the contacts page
// (/) and the lifecycle board (/lifecycle).
//
// Extracted from sales-loop-crm.tsx, where it was inline JSX driven by a large
// untyped `detail` view-model object. Now that the panel is its own component the
// view-model is gone: the derived values are typed locals below, so the props are
// checked rather than being funnelled through `any`.
//
// DEPENDENCY DIRECTION: this module imports ./data, ./ui and ../lib/validate only.
// It must never import sales-loop-crm.tsx — that file imports *this* one, and the
// same rule that keeps sidebar.tsx free of it (so /analytics doesn't pull the whole
// contacts page into its bundle) applies here.
//
// The panel is purely presentational plus callbacks. In particular its Delete
// button does NOT delete: it calls `onDelete`, and the page owns the confirm modal
// (see DeleteContactsModal below) because the contacts page drives that same modal
// from its bulk selection bar. Likewise setting a status to "Dead" is intercepted
// by the page, not here, so the dead-reason prompt fires from both pages.

import {
  ago,
  CH,
  conflictOwners,
  type Contact,
  fmtDate,
  loopBadge,
  type NameIndex,
  NO_TOUCH_ICON,
  OWNERS,
  type Owner,
  statusMeta,
  statusPill,
  STATUSES,
  type Viewer,
} from "./data";
import {
  Box,
  css,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconTrash,
  IconWarn,
  MONO,
} from "./ui";
import { DEAD_REASONS, LIMITS, safeMailto } from "../lib/validate";

/** Channel-styling fallback for a contact with no touchpoints, or an unknown one. */
export const NO_TOUCH = {
  label: "No touch yet",
  bg: "#f2f2f0",
  fg: "#a3a39d",
  icon: NO_TOUCH_ICON,
};

/**
 * OWNERS lookup that can't reach the prototype chain. A bare `OWNERS[name]` with
 * name === "constructor" returns a function rather than undefined, so the
 * `|| { … }` fallbacks at the call sites would pass a truthy non-Owner through.
 *
 * Not interchangeable with data.ts's `ownerAvatar`, which substitutes a fallback
 * Owner; this returns null so callers can pick their own placeholder.
 */
export function ownerMeta(name: string | null | undefined): Owner | null {
  return name && Object.hasOwn(OWNERS, name) ? OWNERS[name] : null;
}

/** Channels offered by the "Log touch" chips. Meeting has its own button. */
export const TOUCH_CHANNELS = ["ad", "email", "linkedin", "call"];

/**
 * Statuses that must go through the dead-reason prompt before being written.
 *
 * Both pages branch on this rather than testing `=== "Dead"` inline. The bug it
 * prevents is specific: if the lifecycle board's drop handler submitted
 * `setStatus` directly when a card lands on Churned, every drag-churned contact
 * would be recorded with no reason and show up in the analytics breakdown as
 * "Unspecified" forever.
 */
export function needsDeadReason(status: string): boolean {
  return status === "Dead";
}

// Normalize a stored LinkedIn value (URL or bare handle) into an absolute href.
// Empty when there's nothing to link to.
export const linkedinUrl = (raw: string | null | undefined) => {
  const v = (raw || "").trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
};

// Small amber pill marking a Loop 2 contact's community/event of origin.
export function SourceTag({ label }: { label: string }) {
  return (
    <span
      title={"From " + label}
      style={css(
        "display:inline-flex; align-items:center; gap:4px; max-width:150px; padding:1px 7px 1px 6px; border-radius:6px; font-size:11px; font-weight:500; background:#faf3e6; color:#9a6f34; border:1px solid #f0e4cf; white-space:nowrap; overflow:hidden; flex:0 0 auto;",
      )}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={css("flex:0 0 auto;")}>
        <path
          d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M12 6v12" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.5 2.5" />
      </svg>
      <span style={css("overflow:hidden; text-overflow:ellipsis;")}>{label}</span>
    </span>
  );
}

// Small clickable LinkedIn glyph that opens the profile in a new tab. Stops
// click propagation so it doesn't also open the contact detail panel.
//
// `draggable={false}` is load-bearing on the lifecycle board: an anchor is
// natively draggable, so without it grabbing this glyph starts a URL drag
// instead of dragging the card it sits on. Inert on the contacts table.
export function LinkedinButton({
  href,
  stopProp,
}: {
  href: string;
  stopProp: (e: any) => void;
}) {
  return (
    <Box
      as="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      draggable={false}
      onClick={stopProp}
      title="Open LinkedIn profile"
      style={css(
        "flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:5px; color:" +
          CH.linkedin.fg +
          "; background:" +
          CH.linkedin.bg +
          "; text-decoration:none;",
      )}
      hover={css("filter:brightness(0.95);")}
    >
      <span dangerouslySetInnerHTML={{ __html: CH.linkedin.icon }} style={css("display:flex;")} />
    </Box>
  );
}

export type ContactDetailProps = {
  contact: Contact;
  viewer: Viewer;
  /** Built once per page with buildNameIndex(contacts); drives the conflict banner. */
  nameIndex: NameIndex;
  noteDraft: string;
  statusMenuOpen: boolean;
  /** fetcher.state !== "idle" — disables the HyperAgent button while in flight. */
  pending: boolean;
  onClose: () => void;
  onToggleStatusMenu: () => void;
  /** Takes the event so the page can stopPropagation on nested menus. */
  onSetStatus: (id: string, status: string, e?: unknown) => void;
  onNoteInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onNoteKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onAddNote: () => void;
  onLogMeeting: () => void;
  onLogTouch: (ch: string) => void;
  onSnoozeFollow: () => void;
  onClearFollow: () => void;
  onResumeLoop1: () => void;
  onDraftOutreach: () => void;
  /** Opens the page's confirm modal — this does not delete on its own. */
  onDelete: (ids: string[]) => void;
};

export function ContactDetail({
  contact,
  viewer,
  nameIndex,
  noteDraft,
  statusMenuOpen,
  pending,
  onClose,
  onToggleStatusMenu,
  onSetStatus,
  onNoteInput,
  onNoteKey,
  onAddNote,
  onLogMeeting,
  onLogTouch,
  onSnoozeFollow,
  onClearFollow,
  onResumeLoop1,
  onDraftOutreach,
  onDelete,
}: ContactDetailProps) {
  const o = ownerMeta(contact.owner);
  const m = statusMeta(contact.status);
  const conflictWith = conflictOwners(contact, nameIndex);
  const conflict = conflictWith.length > 0;
  const lastT = contact.touches[0];

  const statusMenu = STATUSES.map((s) => ({
    label: s.id,
    dot: s.dot,
    active: s.id === contact.status,
    onClick: (e: unknown) => onSetStatus(contact.id, s.id, e),
    style:
      "display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:none;background:none;border-radius:7px;font-size:12.5px;font-family:inherit;color:#2a2a28;cursor:pointer;text-align:left;",
  }));

  let followLabel: string;
  let followColor = "#75756f";
  let hasFollow = false;
  let snoozeLabel = "Set follow-up";
  if (contact.followUp !== null) {
    hasFollow = true;
    snoozeLabel = "Snooze 3d";
    const due = -contact.followUp;
    if (due <= 0) {
      followLabel = "Due today";
      followColor = "#c2410c";
    } else {
      followLabel =
        "Due in " +
        due +
        " day" +
        (due > 1 ? "s" : "") +
        (contact.followUpDateLabel ? " · " + contact.followUpDateLabel : "");
      followColor = due <= 1 ? "#c2410c" : "#75756f";
    }
  } else {
    followLabel = "No reminder set";
  }

  // Contact-info rows - only the channels that have a value. Icons reuse the
  // channel SVG strings from CH (rendered via dangerouslySetInnerHTML below).
  const linkedinRaw = (contact.linkedin || "").trim();
  const linkedinHref = linkedinRaw
    ? /^https?:\/\//i.test(linkedinRaw)
      ? linkedinRaw
      : "https://" + linkedinRaw
    : "";
  const contactInfo = [
    contact.email && contact.email.trim()
      ? {
          iconHtml: { __html: CH.email.icon },
          iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.email.bg};color:${CH.email.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
          label: contact.email.trim(),
          // safeMailto, not string concatenation: a stored address containing
          // `?bcc=…&subject=…&body=…` would otherwise prefill an
          // attacker-controlled draft in the user's mail client. Returns null
          // for anything that isn't a plain address, and the row then renders
          // as text with no link.
          href: safeMailto(contact.email),
          external: false,
        }
      : null,
    contact.phone && contact.phone.trim()
      ? {
          iconHtml: { __html: CH.call.icon },
          iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.call.bg};color:${CH.call.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
          label: contact.phone.trim(),
          href: "tel:" + contact.phone.trim().replace(/[^\d+]/g, ""),
          external: false,
        }
      : null,
    linkedinRaw
      ? {
          iconHtml: { __html: CH.linkedin.icon },
          iconWrap: `width:30px;height:30px;border-radius:8px;background:${CH.linkedin.bg};color:${CH.linkedin.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
          label: linkedinRaw.replace(/^https?:\/\//i, ""),
          href: linkedinHref,
          external: true,
        }
      : null,
  ].filter((r): r is NonNullable<typeof r> => r !== null);

  const loops = contact.loops.map((l) => loopBadge(l, false));
  const notes = contact.notes.map((n) => ({
    author: n.author,
    ago: ago(n.daysAgo),
    text: n.text,
    color: ownerMeta(n.author)?.color ?? "#b0b0aa",
    initial: ownerMeta(n.author)?.initial ?? "?",
  }));
  const timeline = contact.touches.map((t, i) => {
    const c2 = CH[t.ch] ?? NO_TOUCH;
    return {
      channel: c2.label,
      iconHtml: { __html: c2.icon },
      iconWrap: `width:26px;height:26px;border-radius:8px;background:${c2.bg};color:${c2.fg};display:flex;align-items:center;justify-content:center;flex:0 0 auto;`,
      loopLabel: "Loop " + t.loop,
      loopStyle: loopBadge(t.loop, true).style,
      date: fmtDate(t.daysAgo),
      owner: t.owner,
      hasNote: !!t.note,
      note: t.note,
      hasLine: i < contact.touches.length - 1,
    };
  });

  const ownerName = contact.owner || "Unassigned";
  const ownerColor = o ? o.color : "#b0b0aa";
  const ownerInitial = o ? o.initial : "?";
  const hasSource = !!(contact.source && contact.source.trim());
  const canResume = contact.loops.includes(2) && !contact.resumedToLoop1At;
  const conflictText = conflict
    ? contact.owner
      ? `Also owned by ${conflictWith.join(" & ")} - you both have a contact named “${contact.name}”. Confirm who's driving before the next outreach.`
      : `${conflictWith.join(" & ")} ${conflictWith.length > 1 ? "each have" : "has"} a contact named “${contact.name}”. Assign one owner to avoid double-touching.`
    : "";

  return (
    <>
      <div onClick={onClose} style={css("position:fixed; inset:0; background:rgba(20,20,18,0.18); z-index:50; animation:slcrm-fadeIn 0.15s ease;")} />
      <div style={css("position:fixed; top:0; right:0; bottom:0; width:480px; max-width:92vw; background:#fff; z-index:51; box-shadow:-8px 0 40px rgba(0,0,0,0.1); display:flex; flex-direction:column; animation:slcrm-slideIn 0.18s cubic-bezier(0.2,0.8,0.2,1);")}>
        <div style={css("padding:20px 24px 16px; border-bottom:1px solid #ededea;")}>
          <div style={css("display:flex; align-items:flex-start; gap:12px;")}>
            <span style={css(`width:38px; height:38px; border-radius:10px; background:${ownerColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:600; flex:0 0 auto;`)}>{ownerInitial}</span>
            <div style={css("flex:1; min-width:0;")}>
              <div style={css("font-size:18px; font-weight:600; letter-spacing:-0.015em; line-height:1.2;")}>{contact.name}</div>
              <div style={css("font-size:13px; color:#9a9a95; margin-top:2px;")}>{contact.company} · owned by {ownerName}</div>
              {hasSource && (
                <div style={css("font-size:12.5px; color:#b45309; margin-top:3px; display:flex; align-items:center; gap:5px;")}>
                  <span style={css("width:6px; height:6px; border-radius:3px; background:#e0930a; flex:0 0 auto;")} />
                  From {contact.source}
                </div>
              )}
            </div>
            <Box as="button" onClick={onClose} style={css("border:none; background:#f2f2ef; width:30px; height:30px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66; flex:0 0 auto;")} hover={css("background:#e8e8e4;")}>
              <IconClose />
            </Box>
          </div>
          <div style={css("display:flex; align-items:center; gap:8px; margin-top:14px; flex-wrap:wrap;")}>
            {loops.map((lp, j) => (
              <span key={j} style={css(lp.style)}>{lp.label}</span>
            ))}
            <div style={css("position:relative;")}>
              <Box as="button" onClick={onToggleStatusMenu} style={css(statusPill(contact.status, true))} hover={css("filter:brightness(0.97);")}>
                <span style={css(`width:6px; height:6px; border-radius:4px; background:${m.dot};`)} />
                {contact.status}
                <IconChevronDown style={css("opacity:0.5;")} />
              </Box>
              {statusMenuOpen && (
                <div style={css("position:absolute; top:calc(100% + 4px); left:0; z-index:20; background:#fff; border:1px solid #e6e6e2; border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.12); padding:4px; min-width:150px;")}>
                  {statusMenu.map((opt, j) => (
                    <Box as="button" key={j} onClick={opt.onClick} style={css(opt.style)} hover={css("background:#f4f4f1;")}>
                      <span style={css(`width:6px; height:6px; border-radius:4px; background:${opt.dot};`)} />
                      {opt.label}
                      {opt.active && <IconCheck style={css("margin-left:auto; color:#3a3a38;")} />}
                    </Box>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={css("flex:1; overflow-y:auto; padding:0 24px 24px;")}>
          {conflict && (
            <div style={css("display:flex; gap:10px; align-items:flex-start; background:#fef2f2; border:1px solid #fbd5d5; border-radius:10px; padding:12px 14px; margin-top:16px;")}>
              <IconWarn size={16} style={css("color:#dc2626; flex:0 0 auto; margin-top:1px;")} />
              <div style={css("font-size:12.5px; color:#991b1b; line-height:1.45;")}>{conflictText}</div>
            </div>
          )}

          {contactInfo.length > 0 && (
            <div style={css("margin-top:16px;")}>
              <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;")}>Contact info</div>
              <div style={css("border:1px solid #ededea; border-radius:11px; overflow:hidden; background:#fff;")}>
                {contactInfo.map((ci, j) => (
                  <Box
                    as={ci.href ? "a" : "div"}
                    key={j}
                    {...(ci.href ? { href: ci.href } : {})}
                    {...(ci.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    style={css(`display:flex; align-items:center; gap:11px; padding:11px 13px; text-decoration:none; color:#2a2a28; ${j > 0 ? "border-top:1px solid #f2f2f0;" : ""}`)}
                    hover={css("background:#faf9f6;")}
                  >
                    <span style={css(ci.iconWrap)}>
                      <span dangerouslySetInnerHTML={ci.iconHtml} style={css("display:flex;")} />
                    </span>
                    <span style={css("font-size:13px; color:#2a2a28; word-break:break-all; min-width:0; flex:1;")}>{ci.label}</span>
                    {ci.external && <IconChevronRight />}
                  </Box>
                ))}
              </div>
            </div>
          )}

          <div style={css("margin-top:16px; border:1px solid #ededea; border-radius:11px; padding:14px; background:#fbfbfa;")}>
            <div style={css("display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
              <div style={css("display:flex; align-items:center; gap:9px;")}>
                <IconCalendar style={css(`color:${followColor};`)} />
                <div>
                  <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>Follow-up</div>
                  <div style={css(`font-size:12px; color:${followColor}; margin-top:1px;`)}>{followLabel}</div>
                </div>
              </div>
              <div style={css("display:flex; gap:6px;")}>
                {hasFollow && (
                  <Box as="button" onClick={onClearFollow} style={css("border:1px solid #e6e6e2; background:#fff; padding:6px 11px; border-radius:8px; font-size:12px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Mark done</Box>
                )}
                <Box as="button" onClick={onSnoozeFollow} style={css("border:1px solid #e6e6e2; background:#fff; padding:6px 11px; border-radius:8px; font-size:12px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>{snoozeLabel}</Box>
              </div>
            </div>
          </div>

          <div style={css("margin-top:12px; border:1px solid #ededea; border-radius:11px; padding:14px; background:#fbfbfa; display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
            <div style={css("min-width:0;")}>
              <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>Draft outreach with HyperAgent</div>
              <div style={css("font-size:12px; color:#75756f; margin-top:1px;")}>Hand this contact to a HyperAgent run; results post back to the timeline.</div>
            </div>
            <Box as="button" onClick={onDraftOutreach} disabled={pending} style={css(`border:none; background:#1a1a1a; color:#fff; padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:${pending ? "default" : "pointer"}; white-space:nowrap; flex:0 0 auto; opacity:${pending ? "0.6" : "1"};`)} hover={css("background:#333;")}>
              {pending ? "Working…" : "Draft outreach"}
            </Box>
          </div>

          {canResume && (
            <div style={css("margin-top:12px; border:1px solid #ededea; border-radius:11px; padding:14px; background:#fbfbfa; display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
              <div style={css("min-width:0;")}>
                <div style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>Didn’t convert?</div>
                <div style={css("font-size:12px; color:#75756f; margin-top:1px;")}>Resume this Loop 2 contact into Loop 1 outbound.</div>
              </div>
              <Box as="button" onClick={onResumeLoop1} style={css("border:1px solid #e6e6e2; background:#fff; padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:pointer; color:#3a3a38; white-space:nowrap; flex:0 0 auto;")} hover={css("background:#f4f4f1;")}>Resume to Loop 1</Box>
            </div>
          )}
          {!!contact.resumedToLoop1At && (
            <div style={css("margin-top:12px; display:flex; align-items:center; gap:8px; background:#f0f0ec; border:1px solid #e6e6e2; border-radius:10px; padding:10px 14px; font-size:12.5px; color:#575753;")}>
              <IconCheck style={css("color:#1f7a4d; flex:0 0 auto;")} />
              {contact.resumedLabel}
            </div>
          )}

          <div style={css("margin-top:18px;")}>
            <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:8px;")}>Quick note</div>
            <div style={css("display:flex; gap:8px; align-items:flex-start;")}>
              <span style={css(`width:26px; height:26px; border-radius:7px; background:${viewer.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex:0 0 auto; margin-top:2px;`)}>{viewer.initial}</span>
              <div style={css("flex:1;")}>
                <Box
                  as="textarea"
                  value={noteDraft}
                  maxLength={LIMITS.note}
                  onChange={onNoteInput}
                  onKeyDown={onNoteKey}
                  placeholder={`Add a note as ${viewer.name}… (⌘↵ to save)`}
                  style={css("width:100%; min-height:58px; resize:vertical; padding:9px 11px; border:1px solid #e6e6e2; border-radius:9px; font-size:13px; font-family:inherit; background:#fff; outline:none; color:#1a1a1a; line-height:1.5;")}
                  focus={css("border-color:#c9c9c3;")}
                />
                <div style={css("display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:7px;")}>
                  <Box as="button" onClick={onLogMeeting} style={css("display:flex; align-items:center; gap:6px; border:1px solid #e6e6e2; background:#fff; color:#575753; padding:7px 12px; border-radius:8px; font-size:12.5px; font-family:inherit; cursor:pointer;")} hover={css("background:#f4f4f1;")}>
                    <IconCalendar style={css("width:14px; height:14px; color:#75756f;")} />
                    Log as meeting note
                  </Box>
                  <button onClick={onAddNote} style={css("border:none; background:#1a1a1a; color:#fff; padding:7px 14px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:pointer;")}>Add note</button>
                </div>

                {/* Records outreach on a channel, which is what the analytics
                    channel breakdown and activity chart are built from. The
                    draft above rides along as the touch note when present. */}
                <div style={css("display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:10px;")}>
                  <span style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em; margin-right:2px;")}>Log touch</span>
                  {TOUCH_CHANNELS.map((key) => (
                    <Box
                      as="button"
                      key={key}
                      onClick={() => onLogTouch(key)}
                      title={`Log a ${CH[key].label.toLowerCase()} touchpoint`}
                      style={css(`display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border-radius:7px; border:1px solid #e6e6e2; background:#fff; color:${CH[key].fg}; font-size:12px; font-weight:500; font-family:inherit; cursor:pointer;`)}
                      hover={css(`background:${CH[key].bg}; border-color:${CH[key].bg};`)}
                    >
                      <span style={css("display:flex; align-items:center;")} dangerouslySetInnerHTML={{ __html: CH[key].icon }} />
                      {CH[key].label}
                    </Box>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {notes.length > 0 && (
            <div style={css("margin-top:12px; display:flex; flex-direction:column; gap:8px;")}>
              {notes.map((n, j) => (
                <div key={j} style={css("display:flex; gap:9px; padding:11px 12px; background:#faf9f6; border:1px solid #efeee9; border-radius:10px;")}>
                  <span style={css(`width:22px; height:22px; border-radius:6px; background:${n.color}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; flex:0 0 auto; margin-top:1px;`)}>{n.initial}</span>
                  <div style={css("min-width:0;")}>
                    <div style={css("font-size:11.5px; color:#9a9a95; margin-bottom:2px;")}><span style={css("color:#575753; font-weight:500;")}>{n.author}</span> · {n.ago}</div>
                    <div style={css("font-size:13px; color:#2a2a28; line-height:1.5; white-space:pre-wrap;")}>{n.text}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={css("margin-top:22px;")}>
            <div style={css("display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;")}>
              <div style={css("font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.04em;")}>Touchpoint history</div>
              <div style={css("font-size:11.5px; color:#a3a39d;")}>Last reached by <span style={css("color:#3a3a38; font-weight:500;")}>{lastT ? lastT.owner : "-"}</span></div>
            </div>
            <div style={css("position:relative; padding-left:4px;")}>
              {timeline.map((t, j) => (
                <div key={j} style={css("display:grid; grid-template-columns:26px 1fr; gap:12px; padding-bottom:16px; position:relative;")}>
                  <div style={css("display:flex; flex-direction:column; align-items:center;")}>
                    <span style={css(t.iconWrap)}><span dangerouslySetInnerHTML={t.iconHtml} style={css("display:flex;")} /></span>
                    {t.hasLine && <span style={css("width:2px; flex:1; background:#ededea; margin-top:4px;")} />}
                  </div>
                  <div style={css("padding-top:1px;")}>
                    <div style={css("display:flex; align-items:center; gap:8px; flex-wrap:wrap;")}>
                      <span style={css("font-size:13px; font-weight:500; color:#1a1a1a;")}>{t.channel}</span>
                      <span style={css(t.loopStyle)}>{t.loopLabel}</span>
                      <span style={css("font-size:11.5px; color:#a3a39d; margin-left:auto;" + MONO)}>{t.date}</span>
                    </div>
                    <div style={css("font-size:12px; color:#75756f; margin-top:2px;")}>by {t.owner}</div>
                    {t.hasNote && (
                      <div style={css("font-size:12.5px; color:#4a4a46; margin-top:5px; line-height:1.45;")}>{t.note}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={css("margin-top:18px; border:1px solid #f3dcdc; border-radius:11px; padding:14px; background:#fefafa; display:flex; align-items:center; justify-content:space-between; gap:12px;")}>
            <div style={css("min-width:0;")}>
              <div style={css("font-size:13px; font-weight:500; color:#991b1b;")}>Delete contact</div>
              <div style={css("font-size:12px; color:#a16060; margin-top:1px;")}>Removes this contact with its notes and touchpoint history. Can’t be undone.</div>
            </div>
            <Box as="button" onClick={() => onDelete([contact.id])} style={css("display:flex; align-items:center; gap:7px; border:1px solid #f0cccc; background:#fff; color:#b91c1c; padding:7px 13px; border-radius:8px; font-size:12.5px; font-weight:500; font-family:inherit; cursor:pointer; white-space:nowrap; flex:0 0 auto;")} hover={css("background:#dc2626; color:#fff; border-color:#dc2626;")}>
              <IconTrash />
              Delete
            </Box>
          </div>
        </div>
      </div>
    </>
  );
}

// --- The two modals the panel triggers -------------------------------------
//
// Bodies only: each page keeps its own overlay + card wrapper, which is already
// how sales-loop-crm.tsx and templates-page.tsx do it (they differ in width, and
// the codebase has twice declined to abstract that shell). What is shared here is
// the *behaviour* — the dead-reason list is the closed set analytics groups on,
// and the delete copy describes a hard cascade delete — where a drifted second
// copy would be a real bug rather than a cosmetic one.

export function DeleteContactsModal({
  targets,
  pending,
  actionError,
  onCancel,
  onConfirm,
}: {
  targets: Contact[];
  pending: boolean;
  actionError: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const label = targets.length === 1 ? "“" + targets[0].name + "”" : targets.length + " contacts";
  return (
    <>
      <div style={css("padding:20px 22px 16px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;")}>
        <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>
          Delete {targets.length === 1 ? "contact" : targets.length + " contacts"}
        </div>
        <Box as="button" onClick={onCancel} style={css("border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;")} hover={css("background:#e8e8e4;")}><IconClose size={15} /></Box>
      </div>
      <div style={css("padding:18px 22px 22px; display:flex; flex-direction:column; gap:14px;")}>
        <div style={css("display:flex; gap:11px; align-items:flex-start;")}>
          <span style={css("width:32px; height:32px; border-radius:9px; background:#fef2f2; color:#dc2626; display:flex; align-items:center; justify-content:center; flex:0 0 auto;")}>
            <IconTrash size={16} />
          </span>
          <div style={css("font-size:13px; color:#3a3a38; line-height:1.55;")}>
            Permanently delete {label}, along with every note and touchpoint
            recorded against {targets.length === 1 ? "them" : "each of them"}. This can’t be undone.
          </div>
        </div>
        {targets.length > 1 && (
          <div style={css("max-height:150px; overflow-y:auto; border:1px solid #ededea; border-radius:10px; background:#fbfbfa;")}>
            {targets.map((c, j) => (
              <div key={c.id} style={css(`display:flex; align-items:center; gap:8px; padding:8px 12px; font-size:12.5px; color:#3a3a38; ${j > 0 ? "border-top:1px solid #f2f2f0;" : ""}`)}>
                <span style={css("font-weight:500;")}>{c.name}</span>
                {c.company && <span style={css("color:#9a9a95;")}>· {c.company}</span>}
              </div>
            ))}
          </div>
        )}
        {actionError && <div style={css("font-size:12px; color:#c2410c;")}>{actionError}</div>}
        <div style={css("display:flex; justify-content:flex-end; gap:8px; margin-top:2px;")}>
          <Box as="button" onClick={onCancel} style={css("border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Cancel</Box>
          <Box as="button" onClick={onConfirm} disabled={pending} style={css(`display:flex; align-items:center; gap:7px; border:none; background:#dc2626; color:#fff; padding:9px 16px; border-radius:9px; font-size:13px; font-weight:500; font-family:inherit; cursor:${pending ? "default" : "pointer"}; opacity:${pending ? "0.6" : "1"};`)} hover={css(pending ? "" : "background:#b91c1c;")}>
            <IconTrash />
            {pending ? "Deleting…" : "Delete"}
          </Box>
        </div>
      </div>
    </>
  );
}

export function DeadReasonModal({
  targetName,
  actionError,
  onPick,
  onCancel,
}: {
  targetName: string;
  actionError: string;
  /** "" means "skip" — still marks the contact dead, just with no reason. */
  onPick: (reason: string) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={css("padding:20px 22px 16px; border-bottom:1px solid #ededea; display:flex; align-items:center; justify-content:space-between;")}>
        <div style={css("font-size:16px; font-weight:600; letter-spacing:-0.01em;")}>Why did this deal die?</div>
        <Box as="button" onClick={onCancel} style={css("border:none; background:#f2f2ef; width:28px; height:28px; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; color:#6b6b66;")} hover={css("background:#e8e8e4;")}><IconClose size={15} /></Box>
      </div>
      <div style={css("padding:18px 22px 22px; display:flex; flex-direction:column; gap:14px;")}>
        <div style={css("font-size:13px; color:#3a3a38; line-height:1.55;")}>
          {targetName ? (
            <>Marking <span style={css("font-weight:500;")}>{targetName}</span> as dead. The reason feeds the analytics breakdown.</>
          ) : (
            <>The reason feeds the analytics breakdown.</>
          )}
        </div>
        <div style={css("display:flex; flex-wrap:wrap; gap:8px;")}>
          {DEAD_REASONS.map((reason) => (
            <Box
              as="button"
              key={reason}
              onClick={() => onPick(reason)}
              style={css("border:1px solid #e6e6e2; background:#fff; color:#3a3a38; padding:9px 14px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer;")}
              hover={css("background:#f4ecec; border-color:#f0cccc; color:#9a5b5b;")}
            >
              {reason}
            </Box>
          ))}
        </div>
        {actionError && <div style={css("font-size:12px; color:#c2410c;")}>{actionError}</div>}
        <div style={css("display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:2px;")}>
          {/* Skipping still marks the contact dead — it just records no
              reason, which analytics reports as "Unspecified". */}
          <Box as="button" onClick={() => onPick("")} style={css("border:none; background:none; padding:9px 4px; font-size:12.5px; font-family:inherit; cursor:pointer; color:#9a9a95;")} hover={css("color:#575753;")}>
            Skip: mark dead without a reason
          </Box>
          <Box as="button" onClick={onCancel} style={css("border:1px solid #e6e6e2; background:#fff; padding:9px 15px; border-radius:9px; font-size:13px; font-family:inherit; cursor:pointer; color:#575753;")} hover={css("background:#f4f4f1;")}>Cancel</Box>
        </div>
      </div>
    </>
  );
}
