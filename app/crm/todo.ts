// The contacts page's To do list: one line per contact saying what the next
// move on it is.
//
// This replaces `needsAttention` (removed from ./data.ts), and the difference
// is the whole point. That returned a *flag and a reason* — "No reply · 2w ago"
// — which told you a contact was in a bad state and left you to work out what
// to do about it. This returns an *instruction*: reply to them, DM the ones who
// opened, call them, try LinkedIn, send the step that is due. Same signals, read
// rather than as an alarm, which is the shape Smartlead's inbox-side task list
// has and the reason that one gets worked through.
//
// ONE TO-DO PER CONTACT, deliberately. A contact who has gone quiet on email is
// simultaneously "chase on LinkedIn", "call them" and "the step you scheduled
// is due", and listing all three is how a queue becomes wallpaper. nextTodo()
// walks the rules in TODO_KINDS order and returns the first that fires, so the
// list is bounded by the contact book and every line is the single next action.
// It is also what makes the `todo` saved-view field (./views.ts) answerable:
// "todo is call" is a set, not an overlapping tag.
//
// PURE AND ISOMORPHIC: no React, no server imports, no `Date`. The same
// contract as ./views.ts and for the same three reasons — the page derives the
// list during render with no round trip, SSR and hydration agree byte for byte,
// and ./views.ts can import it without dragging a component tree into
// validate.ts. Every time figure here is a `daysAgo` already on the Contact,
// resolved by the loader against one `now`.
//
// WHAT IT CANNOT SEE, and why the rules are shaped around that. Touchpoints
// have no direction column (see migrations/0021 on why replies are their own
// table): a row says "email, 3 days ago", not who sent it. So no rule here may
// depend on telling our email from theirs. `status` is what carries that fact —
// the Unipile sync promotes a contact to `Replied` when it matches an inbound
// message — and it is why the reply rule below reads the status rather than
// counting touches.
//
// WHAT IT CAN SEE THAT THE TIMELINE CANNOT: the open. `openedStep` and
// `campaignReplied` on the Contact (see ./data.ts) come from
// smartlead_email_events, not from touchpoints — they are what the SENDING TOOL
// observed rather than what this CRM did, which is why they are separate fields
// and not rows in `touches`. They are the only inputs here that are absent for a
// contact no campaign has emailed, so every rule reading them must treat missing
// as "unknown" rather than as zero.
//
// THE ONE EXCEPTION, AND IT IS LOAD-BEARING: the note prefix. Every count and
// every silence figure the channel ladder is built from is OUTBOUND ONLY,
// recognised by `isInbound` below. Without that, an out-of-office autoresponder
// — filed by the Unipile sync as an ordinary `email` touchpoint — counts as one
// of the emails WE sent, and one real send plus one autoresponder trips the
// two-unanswered-emails threshold after a single step of the sequence.

import { REPLY_NOTE_PREFIX } from "./campaigns";
import type { Contact, Touch } from "./data";

export const TODO_KINDS = [
  "reply",
  "opened",
  "call",
  "linkedin",
  "sequence",
  "assign",
  "add",
] as const;

export type TodoKind = (typeof TODO_KINDS)[number];

/**
 * How long a channel has to be quiet before it counts as silence.
 *
 * Five days, not three: a sequence's own steps are a few days apart, so a
 * shorter window would put "email went silent, try LinkedIn" on contacts whose
 * next scheduled email has not gone out yet — telling someone to break into
 * their own sequence.
 */
export const SILENT_DAYS = 5;

/**
 * How many emails have to have gone out, unanswered, before the list suggests
 * LinkedIn.
 *
 * One email is not a sequence, it is the first step of one, and the answer to
 * silence after it is the second email — which the campaign will send on its
 * own. Two is the point at which the channel itself is the thing that is not
 * working, and switching channels stops being impatience.
 */
export const EMAILS_BEFORE_LINKEDIN = 2;

/**
 * The sequence step whose OPEN makes LinkedIn the next move, on its own.
 *
 * Two, matching EMAILS_BEFORE_LINKEDIN above and for the same reason: opening
 * step one is somebody checking who wrote to them, and the answer to it is the
 * second email, which the campaign sends by itself. Opening the second is a
 * person who has now read us twice and still not written back — which is the
 * point where the channel, not the copy, is what is in the way.
 *
 * `>=`, not `===`: a five-step sequence has openers at three and four, and they
 * are warmer than the step-two openers, not colder. Reading the furthest step
 * they reached is also what makes one number on the Contact enough (see
 * `openedStep` in ./data.ts) instead of a set of every step they ever opened.
 *
 * WHY THIS RULE EXISTS AT ALL, given the LinkedIn rule below already suggests the
 * same action. That one waits for silence — two emails out and five days quiet —
 * because with nothing but a timeline, silence is the only evidence there is that
 * email is not landing. An open is better evidence and it is evidence of the
 * opposite thing: the person is there, they are reading, and the reply is what is
 * missing. Waiting five more days to act on that spends the warmest moment the
 * campaign will produce. So this fires the day the open is synced, and it is
 * above the silence rule in TODO_KINDS.
 */
export const OPENED_STEP_FOR_LINKEDIN = 2;

export type TodoItem = {
  kind: TodoKind;
  /** The imperative on the row: "Call them". */
  action: string;
  /** One sentence saying why this line exists. */
  why: string;
  /**
   * The CH key (./data.ts) the action happens on, or null when it is not an
   * outreach action at all. The page turns this into the row's channel chip;
   * this module deliberately holds no colours and no icons.
   */
  channel: string | null;
};

export type TodoMeta = {
  /** The group heading on the page. */
  group: string;
  /** The label in the "New view" builder's To do dropdown. */
  viewLabel: string;
  /** The name a view saved from a group header is prefilled with. */
  viewName: string;
  /** The group's dot, from the palette STATUSES and CH already use. */
  dot: string;
  /** Colour of the action verb on a row of this kind. */
  accent: string;
};

export const TODO_META: Record<TodoKind, TodoMeta> = {
  reply: {
    group: "Replies waiting on you",
    viewLabel: "Reply waiting",
    viewName: "Replies to answer",
    dot: "#8b5cf6",
    accent: "#6b3fb5",
  },
  opened: {
    group: "Opened your email",
    viewLabel: "Opened the sequence",
    viewName: "Openers to DM",
    dot: "#0ea5e9",
    accent: "#0369a1",
  },
  call: {
    group: "Calls to make",
    viewLabel: "Call to make",
    viewName: "Calls to make",
    dot: "#f59e0b",
    accent: "#b45309",
  },
  linkedin: {
    group: "LinkedIn follow-ups",
    viewLabel: "LinkedIn follow-up",
    viewName: "LinkedIn follow-ups",
    dot: "#0a7ea4",
    accent: "#0a7ea4",
  },
  sequence: {
    group: "Sequence steps due",
    viewLabel: "Sequence step due",
    viewName: "Sequence steps due",
    dot: "#3b82f6",
    accent: "#1e5aa8",
  },
  assign: {
    group: "Needs an owner",
    viewLabel: "Needs an owner",
    viewName: "Unassigned contacts",
    dot: "#ef4444",
    accent: "#b91c1c",
  },
  add: {
    group: "Not in a sequence",
    viewLabel: "Not in a sequence",
    viewName: "To add to a sequence",
    dot: "#10b981",
    accent: "#1f7a4d",
  },
};

/** Statuses with no next move on this page. Won is delivery's; Dead is nobody's. */
const CLOSED: readonly string[] = ["Won", "Dead"];

/** Days since the newest touch on `ch`, or null if that channel was never used. */
function lastOn(c: Contact, ch: string): number | null {
  // `touches` arrives newest-first from listContacts(), so the first hit is the
  // most recent one. A scan rather than a `.find()` chain because three rules
  // below each want a different channel out of the same array.
  for (const t of c.touches) if (t.ch === ch) return t.daysAgo;
  return null;
}

/**
 * True when a touchpoint records something that ARRIVED rather than something
 * this team sent.
 *
 * A touchpoint has no direction column and no source column, so the note prefix
 * is the only thing separating the two — the same contract /analytics' Email
 * campaigns tab runs on, which is why the constant is imported from
 * ./campaigns.ts (beside the SEND_NOTE_PREFIX its writer uses) rather than
 * spelled again here. Three readers, one string.
 *
 * WHY THIS MATTERS TO THE RULES BELOW. When an out-of-office autoresponder fires
 * on a campaign email, the Unipile sync files it like any other reply: one
 * `email` touchpoint on the contact, noted "Replied from …". Counted naively
 * that is indistinguishable from an email WE sent — so one real send plus one
 * autoresponder read as "2 emails, no reply" and fired the LinkedIn follow-up
 * after a single step of the sequence. Worse, being the newest touch, it also
 * reset the silence clock and held the call rule off for five days.
 *
 * So every figure the ladder is built from counts outbound touches only. Note
 * this is not an out-of-office rule: a genuine reply is not an email we sent
 * either, and neither is a bounce or an "I've left the company" autoresponder.
 * Nothing here has to recognise the text of a message, which is the point —
 * "​what did we send" is a question the timeline can answer exactly, where "is
 * this an autoresponder" is a heuristic that would be wrong on someone's genuine
 * "I'm out of office next week, call me Thursday".
 *
 * The one thing it gets wrong is a rep hand-logging a touch whose note happens
 * to start with "Replied". That undercounts, so a to-do appears later rather
 * than earlier — the safe direction for the exact bug this fixes.
 */
function isInbound(t: Touch): boolean {
  return t.note.startsWith(REPLY_NOTE_PREFIX);
}

/** Days since the newest OUTBOUND touch on `ch`, or null if we never used it. */
function lastOutboundOn(c: Contact, ch: string): number | null {
  for (const t of c.touches) if (t.ch === ch && !isInbound(t)) return t.daysAgo;
  return null;
}

/** How many times WE have used `ch`. Replies arriving on it do not count. */
function countOutboundOn(c: Contact, ch: string): number {
  let n = 0;
  for (const t of c.touches) if (t.ch === ch && !isInbound(t)) n++;
  return n;
}

/** Days since the newest outbound touch of any channel, or null if there is none. */
function lastOutbound(c: Contact): number | null {
  for (const t of c.touches) if (!isInbound(t)) return t.daysAgo;
  return null;
}

/**
 * True when a follow-up date was set and has arrived.
 *
 * NOTE THE SIGN, because the function this file replaces had it backwards.
 * listContacts() stores `followUp = -(dueDay - today)`: 0 is today, POSITIVE is
 * days overdue, NEGATIVE is days still to run. `needsAttention` tested
 * `followUp <= 0`, which flagged every contact with a follow-up scheduled for
 * next week and silently skipped the ones already three days late — the exact
 * inversion of what a queue is for. `>= 0` is the reading /lifecycle has always
 * used (see its `followUpDue`), and it is the one that is true.
 */
export function followUpDue(c: Contact): boolean {
  return c.followUp !== null && c.followUp >= 0;
}

/**
 * Days overdue, for the row's due label. 0 = due today, and a contact whose
 * follow-up has not arrived yet returns null rather than a negative number.
 */
export function daysOverdue(c: Contact): number | null {
  return followUpDue(c) ? (c.followUp as number) : null;
}

/**
 * The channel a reply most likely arrived on: the newest email or LinkedIn
 * touch. Falls back to email — the chip has to say something, and a `Replied`
 * contact with neither touch means the status was set by hand.
 */
function replyChannel(c: Contact): string {
  for (const t of c.touches) if (t.ch === "email" || t.ch === "linkedin") return t.ch;
  return "email";
}

/**
 * The single next action on a contact, or null when there is nothing to do.
 *
 * The order below IS the priority, and it is the same order the page renders
 * the groups in — so "sorted by what to do next" is literally true rather than
 * a caption over an arbitrary sort.
 */
export function nextTodo(c: Contact): TodoItem | null {
  if (CLOSED.includes(c.status)) return null;

  // 1. THEY ANSWERED. Beats everything: there is a person on the other end who
  //    has already done their part. Nothing here checks whether we wrote back,
  //    because nothing in the schema records that (see the header) — the row is
  //    ticked off by hand, or it leaves on its own when the status moves on to
  //    Meeting booked / Won / Dead.
  if (c.status === "Replied") {
    return {
      kind: "reply",
      action: "Reply and book a call",
      why: "They replied. You have not answered yet.",
      channel: replyChannel(c),
    };
  }

  // 2. THEY OPENED THE SEQUENCE AND SAID NOTHING. The warmest signal short of a
  //    reply, and the only rule on this page built from something the CRM did not
  //    do itself — Smartlead's open pixel, stored by the stats sync
  //    (migrations/0022) and folded onto the contact by listContacts().
  //
  //    ABOVE THE LADDER BELOW, deliberately. Every rule under this one is
  //    inferred from silence, and silence is what you reason from when you have
  //    nothing else. Here there is something else: this person opened our second
  //    email. Making them wait out SILENT_DAYS before the list mentions them
  //    throws that away, and the whole reason to switch to LinkedIn is that they
  //    are reading and not replying.
  //
  //    THE REPLY GUARD IS NOT OPTIONAL. `campaignReplied` is Smartlead's own
  //    record that this address answered, and it is a different witness from
  //    `status === "Replied"` — that one is written by the Unipile sync, which
  //    only knows about mailboxes somebody connected on /settings and only as far
  //    back as it has synced. Without this check the list tells a rep to DM
  //    somebody who has already written back, which is the single worst line it
  //    could print.
  //
  //    Requires a profile URL for the same reason the two rules below do: an
  //    instruction nobody can carry out is worse than none. That is also why the
  //    group is usually smaller than the campaign tab's open count — that figure
  //    counts every lead the campaign emailed, including the ones with no
  //    LinkedIn on file and the ones this CRM does not hold at all.
  //
  //    `linkedinCount === 0` keeps this exclusive with the two rules below, so
  //    logging the DM clears the row here exactly as it does there, and the
  //    contact becomes eligible for the call rule once everything goes quiet.
  //
  //    `Meeting booked` is excluded HERE rather than by the shared early return
  //    further down, which the two silence rules deliberately sit above (a booked
  //    meeting that has gone quiet for a week is still worth a nudge). This rule
  //    has no silence requirement at all, so without the check every opener with
  //    a meeting on the calendar would be told to DM them the moment their open
  //    synced, chasing a channel over the top of a call that is already booked.
  const openedStep = c.openedStep ?? 0;
  const openedDeep =
    !c.campaignReplied &&
    c.status !== "Meeting booked" &&
    openedStep >= OPENED_STEP_FOR_LINKEDIN;

  // THE ESCALATION LADDER — the email sequence, then LinkedIn, then the phone.
  //
  // All three rules below are mutually exclusive by construction, including the
  // open rule above: LinkedIn is suggested only when it has NEVER been tried
  // (`linkedinCount === 0`, in the open rule and the silence one alike), and the
  // phone only once it HAS and went unanswered. So no contact can satisfy the
  // call rule and either LinkedIn rule, and the order they are tested in cannot
  // change the answer — which is why it is simply the order they are grouped and
  // displayed in. The two LinkedIn rules DO overlap (an opener whose email also
  // went quiet satisfies both), and there the order is the answer: the open is
  // the better evidence, so it is tested first and names itself on the row.
  //
  // WHAT THE LINKEDIN COUNT ACTUALLY MEASURES, because it is not symmetric with
  // the email one. Email touches are backfilled by the Smartlead sync
  // (`recordContactSends`), so they appear whether or not anyone remembers.
  // LinkedIn touches only exist because a rep pressed "Log touch" on the detail
  // panel — nothing writes them automatically. Two consequences worth keeping in
  // mind before tightening either rule:
  //
  //   * The LinkedIn row is cleared BY logging the touch. That is the loop
  //     working — the list says send one, the rep sends it and logs it, the row
  //     leaves and the contact becomes eligible for the call rule once it goes
  //     quiet. It is also why the row does not need its own persisted "done".
  //   * A message sent and never logged leaves the contact sitting in the
  //     LinkedIn group and keeps it out of the call group. That is the honest
  //     failure direction: this file can only reason about outreach the CRM was
  //     told about, and repeating a nudge costs less than telling someone to
  //     phone a contact who answered a DM nobody recorded.
  // OUTBOUND ONLY, all four — see isInbound. An out-of-office autoresponder
  // lands on the timeline as an `email` touchpoint like any other reply, and
  // counting it as one of ours is what used to fire the LinkedIn follow-up after
  // a single step of the sequence.
  const emailCount = countOutboundOn(c, "email");
  const emailedDaysAgo = lastOutboundOn(c, "email");
  const linkedinCount = countOutboundOn(c, "linkedin");
  const emailSilent = emailedDaysAgo !== null && emailedDaysAgo >= SILENT_DAYS;
  // Not `lastOutboundOn`: a call is always hand-logged and can never be inbound,
  // so the plain lookup says the same thing with one fewer moving part.
  const called = lastOn(c, "call") !== null;
  // Every channel, not just these two: `touches` is newest-first, so this is the
  // age of the most recent thing WE did, of any kind. A meeting note or a
  // dark-ad touch from yesterday means something is still in flight, and the
  // call rule should not fire over the top of it. An autoresponder arriving
  // yesterday is not something in flight, which is why this is outbound too.
  const quietDays = lastOutbound(c);
  const allQuiet = quietDays !== null && quietDays >= SILENT_DAYS;

  // The email sequence has been run and got nothing back. Two emails rather
  // than one — see EMAILS_BEFORE_LINKEDIN — because one email is the first step
  // of a sequence, not a sequence, and the answer to silence after it is the
  // second email, which the campaign sends on its own.
  const emailsIgnored = emailCount >= EMAILS_BEFORE_LINKEDIN && emailSilent;

  if (openedDeep && linkedinCount === 0 && (c.linkedin || "").trim()) {
    return {
      kind: "opened",
      action: "Send a LinkedIn message",
      why: "Opened email " + openedStep + " and never replied.",
      channel: "linkedin",
    };
  }

  // 3. NEITHER WRITTEN CHANNEL GOT AN ANSWER — BOTH, not either. A LinkedIn
  //    message that has gone unanswered is the thing that makes a call the next
  //    move rather than an escalation past a step that was never taken, so the
  //    rule waits for one to have been sent (`linkedinCount > 0`) as well as for
  //    the sequence to have run out. `allQuiet` on top: everything on the
  //    contact, any channel, has to have gone silent, so a call is never
  //    suggested over the top of a message sent three days ago.
  //
  //    Needs a number to ring — an instruction nobody can carry out is worse
  //    than none — and `!called` because a call already placed makes this the
  //    same nudge twice.
  if (
    !called &&
    allQuiet &&
    emailsIgnored &&
    linkedinCount > 0 &&
    (c.phone || "").trim()
  ) {
    return {
      kind: "call",
      action: "Call them",
      why: "Email and LinkedIn both went silent.",
      channel: "call",
    };
  }

  // 4. THE SEQUENCE RAN OUT AND LINKEDIN WAS NEVER TRIED. The cheap next
  //    channel, and the one this rule exists to stop people forgetting.
  //    Requires a profile URL for the same reason the call rule requires a
  //    number.
  if (emailsIgnored && linkedinCount === 0 && (c.linkedin || "").trim()) {
    return {
      kind: "linkedin",
      action: "Send a LinkedIn message",
      why: emailCount + " emails, no reply. Try LinkedIn.",
      channel: "linkedin",
    };
  }

  // 5. A DATE SOMEBODY TYPED HAS ARRIVED. Below the two channel rules on
  //    purpose: those only fire once a contact has already stopped answering on
  //    the channel this step would use again.
  if (followUpDue(c)) {
    return {
      kind: "sequence",
      action: c.touches.length === 0 ? "Send step 1" : "Send the next step",
      why: "The follow-up you set is due.",
      channel: "email",
    };
  }

  // A meeting is on the calendar and nothing is overdue — the next move is in
  // the calendar, not on this page.
  if (c.status === "Meeting booked") return null;

  // 6. NOBODY OWNS IT. Only reached by a contact no outreach rule fired on,
  //    which in practice means one nobody has started — and starting it is
  //    exactly what an owner is for.
  if (!c.owner) {
    return {
      kind: "assign",
      action: "Assign an owner",
      why: "Nobody owns this contact yet.",
      channel: null,
    };
  }

  // 7. OWNED, AND NOTHING HAS EVER BEEN SENT.
  if (c.touches.length === 0) {
    return {
      kind: "add",
      action: "Add to a sequence",
      why: "No outreach has gone out yet.",
      channel: null,
    };
  }

  // Contacted recently and still inside the window the rules allow. "Nothing to
  // do today" is a real answer, and returning null is what keeps the list short
  // enough to be worth reading.
  return null;
}

export type TodoEntry = { contact: Contact; todo: TodoItem };
export type TodoGroup = { kind: TodoKind; meta: TodoMeta; entries: TodoEntry[] };

/**
 * How overdue a contact is, as a sort key — bigger is later. Anything not yet
 * due (including a contact with no follow-up date at all) collapses to -1 so it
 * sorts behind everything that is, rather than interleaving by how far off it
 * is: within a group, "three days late" and "due today" are the distinction
 * worth ordering on and "due next Tuesday" is not.
 */
function dueRank(c: Contact): number {
  return daysOverdue(c) ?? -1;
}

/**
 * Bucket entries into groups, in TODO_KINDS order, dropping empty ones.
 *
 * Within a group: soonest-due first, then longest-silent, then by name so the
 * order is stable across renders. All three keys are already on the Contact, so
 * this stays free of `Date` like the rest of the module.
 */
export function groupTodos(entries: TodoEntry[]): TodoGroup[] {
  const byKind = new Map<TodoKind, TodoEntry[]>();
  for (const e of entries) {
    const list = byKind.get(e.todo.kind) ?? [];
    list.push(e);
    byKind.set(e.todo.kind, list);
  }
  const groups: TodoGroup[] = [];
  for (const kind of TODO_KINDS) {
    const list = byKind.get(kind);
    if (!list || !list.length) continue;
    list.sort(
      (a, b) =>
        dueRank(b.contact) - dueRank(a.contact) ||
        (b.contact.touches[0]?.daysAgo ?? 0) - (a.contact.touches[0]?.daysAgo ?? 0) ||
        a.contact.name.localeCompare(b.contact.name),
    );
    groups.push({ kind, meta: TODO_META[kind], entries: list });
  }
  return groups;
}
