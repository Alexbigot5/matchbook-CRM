// The Smartlead Replies inbox: the shapes that cross the /api/replies boundary,
// and the translation of Smartlead's webhook payloads into rows.
//
// Pure and isomorphic, the same contract as smartlead-map.ts and unipile-map.ts:
// no React, no server imports and NO `Date`. Timestamps pass through as the
// strings Smartlead sent; the writer in crm.server.ts normalises them, and every
// relative label ("today", "3d ago") is computed server-side against one `now`.
//
// SMARTLEAD ONLY. Nothing here knows about channels, because every row this
// module produces came from a Smartlead campaign — see migrations/0026. The
// Unipile inbox (contact_replies) is a different feature and shares no code.
//
// WHY THE PAYLOAD READERS ARE SO TOLERANT. Smartlead's published webhook
// examples and the payloads it actually delivers disagree: the docs show
// EMAIL_REPLY with `reply_body`/`time_replied` and no ids at all, while live
// deliveries also carry `stats_id`, `sl_email_lead_id` and `reply_message` /
// `sent_message` objects. Each field is therefore read from every spelling that
// has been seen, most specific first, and a payload missing something optional
// still stores what it has. The two things a row cannot exist without — the
// campaign and the lead's address — are the only hard requirements.

/** The two tabs. */
export const REPLY_SENTIMENTS = ["positive", "negative"] as const;
export type ReplySentiment = (typeof REPLY_SENTIMENTS)[number];

/** What smartlead_reply_leads.sentiment can hold (NULL aside). */
export type StoredSentiment = "positive" | "negative" | "neutral";

export type ReplyDirection = "SENT" | "REPLY";

/**
 * "Mark meeting booked" also moves the matched contact here, from these only.
 *
 * The mirror of REPLY_PROMOTES_FROM in unipile-map.ts, one step further along
 * the same edge: a booking must not walk `Won` or `Dead` backwards, and turning
 * the flag off never moves anyone — status is edited from the status menu, not
 * inferred back out of a checkbox.
 */
export const MEETING_STATUS = "Meeting booked";
export const MEETING_PROMOTES_FROM = ["New", "Contacted", "Replied"] as const;

/** Longest message body stored. A reply is not a document; this bounds a hostile one. */
export const MAX_REPLY_BODY_CHARS = 20_000;

/** Characters of the latest message the list row carries. It shows one line. */
export const REPLY_PREVIEW_CHARS = 160;

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

/** One row of GET /api/replies. */
export type ReplyListItem = {
  id: string;
  lead: { name: string; company: string; avatarInitials: string };
  isRead: boolean;
  preview: string;
  /** ISO instant of the newest message. */
  updatedAt: string;
  /** The same instant as a day label, computed server-side so no Date renders. */
  updatedLabel: string;
  meetingBooked: boolean;
};

/**
 * GET /api/replies/counts.
 *
 * `positive`/`negative` are every listed thread in that tab, read or not.
 * `unread` is across both tabs and drives the Analytics tab pill.
 * `uncategorized` counts threads in NEITHER tab — no category yet, or a neutral
 * one such as out-of-office — so the page can say they exist rather than let a
 * real reply be invisible because Smartlead has not labelled it.
 */
export type ReplyCounts = {
  positive: number;
  negative: number;
  unread: number;
  uncategorized: number;
};

export const EMPTY_REPLY_COUNTS: ReplyCounts = { positive: 0, negative: 0, unread: 0, uncategorized: 0 };

export type ReplyMessage = {
  id: string;
  direction: ReplyDirection;
  body: string;
  sentAt: string;
  sentLabel: string;
  /** Who wrote it, for the card header: the lead, a CRM user, or the campaign. */
  author: string;
  /**
   * "sent": sent from the CRM, not yet echoed back by a webhook.
   * "unknown": a send from the CRM that never finished recording — it may or may
   * not have gone out, and the page says to check Smartlead.
   */
  delivery: "sent" | "confirmed" | "unknown";
};

export type ReplyTag = { kind: "sentiment" | "meeting"; label: string };

/** GET /api/replies/:threadId. */
export type ReplyThreadDetail = {
  id: string;
  isRead: boolean;
  meetingBooked: boolean;
  subject: string;
  lead: {
    name: string;
    email: string;
    company: string;
    /** From the matched CRM contact; Smartlead's lead has no title field. */
    title: string;
    avatarInitials: string;
    category: string | null;
    sentiment: StoredSentiment | null;
  };
  /** The one CRM contact holding this address, or null (none, or ambiguous). */
  contact: { id: string; name: string; status: string } | null;
  tags: ReplyTag[];
  messages: ReplyMessage[];
  /**
   * Whether the send path has what reply-email-thread needs. False means the
   * webhook never carried a stats id AND there is no lead id to look one up by —
   * the page says so instead of offering a button that can only fail.
   */
  canReply: boolean;
};

// ---------------------------------------------------------------------------
// Presentation helpers (isomorphic)
// ---------------------------------------------------------------------------

export function leadDisplayName(first: string, last: string, email: string): string {
  return `${first} ${last}`.replace(/\s+/g, " ").trim() || email;
}

/** Two letters for the avatar chip: first + last initial, else the first word(s) of what there is. */
export function avatarInitials(first: string, last: string, email: string): string {
  const head = (s: string) => Array.from(s.trim())[0] ?? "";
  if (first.trim() && last.trim()) return (head(first) + head(last)).toUpperCase();
  const words = (first.trim() || last.trim() || email.split("@")[0] || "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  return (head(words[0]) + head(words[1])).toUpperCase();
}

const AVATAR_COLORS = ["#5b4fd6", "#2f7a5b", "#b4572e", "#2f6ea8", "#8a4fb0", "#a8462f", "#3d7f8f"];

/** A stable colour per lead, so the same person reads as the same chip everywhere. */
export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function sentimentLabel(sentiment: StoredSentiment | null): string {
  if (sentiment === "positive") return "Positive";
  if (sentiment === "negative") return "Negative";
  if (sentiment === "neutral") return "Neutral";
  return "Uncategorized";
}

export function isReplySentiment(value: unknown): value is ReplySentiment {
  return value === "positive" || value === "negative";
}

// ---------------------------------------------------------------------------
// Smartlead sentiment
// ---------------------------------------------------------------------------

/**
 * Fold Smartlead's `sentiment_type` onto the stored three values.
 *
 * Substring rather than equality, for the reason positiveCategoryNames() gives
 * in smartlead-map.ts: the field arrives as `positive`, `POSITIVE` and
 * `positive_sentiment` on different accounts. Anything else that is non-empty is
 * neutral (Smartlead's own out-of-office category is), and an absent value is
 * null — unknown, which is not the same claim as neutral.
 */
export function sentimentFromType(raw: unknown): StoredSentiment | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!v) return null;
  if (v.includes("positive")) return "positive";
  if (v.includes("negative")) return "negative";
  return "neutral";
}

/**
 * Sentiment per category name (lowercased), from GET /leads/fetch-categories.
 *
 * The fallback for a webhook that names a category without its sentiment_type.
 * The same endpoint positiveCategoryNames() in smartlead-map.ts reads for the
 * stats sync; this one keeps negative and neutral too, because the Replies tabs
 * need both sides.
 */
export function categorySentimentsByName(
  rows: { name?: unknown; sentiment_type?: unknown }[],
): Map<string, StoredSentiment | null> {
  const out = new Map<string, StoredSentiment | null>();
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name.trim().toLowerCase() : "";
    if (name) out.set(name, sentimentFromType(row.sentiment_type));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Cut quoted history out of a plain-text body, keeping line breaks.
 *
 * The same markers unipile-map.ts's toSnippet() cuts at — a leading `>`, "On
 * <date>, X wrote:", Outlook's Original Message rule and a long underscore rule —
 * plus Outlook's "From: … Sent:" header block. The thread view already shows
 * every earlier message as its own card, so leaving the quote in would print
 * each email two or three times. A marker at position 0 is ignored: a message
 * that is nothing BUT a quote is better shown whole than as nothing.
 */
function cutQuotedText(text: string): string {
  const cutPoints = [
    text.search(/\n[ \t]*>/),
    text.search(/\n\s*-{2,}\s*Original Message\s*-{2,}/i),
    text.search(/\n[ \t]*On [^\n]{4,160}\bwrote:/),
    text.search(/\n\s*_{10,}/),
    text.search(/\n[ \t]*From:[^\n]*\n[ \t]*(Sent|Date):/i),
  ].filter((i) => i > 0);
  return cutPoints.length ? text.slice(0, Math.min(...cutPoints)) : text;
}

/**
 * Smartlead's email HTML (or plain text) as the text the thread view shows.
 *
 * Quote CONTAINERS are cut in the HTML, before flattening, because that is where
 * they are unambiguous: Gmail's `gmail_quote` div, a `<blockquote>`, Outlook's
 * `divRplyFwdMsg`. Flattening first would leave only the text heuristics above.
 *
 * This is a display transform, not a sanitiser — the output is rendered as a
 * React text node, never as markup, which is what makes a hostile body inert.
 */
export function messageBodyText(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  if (!s) return "";
  if (/<[a-z!/][^>]*>/i.test(s)) {
    s = s.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    const quoteAt = s.search(
      /<blockquote\b|<div[^>]*\b(class|id)\s*=\s*["']?[^"'>]*(gmail_quote|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg|appendonsend)/i,
    );
    if (quoteAt > 0) s = s.slice(0, quoteAt);
    s = s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|table)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]*>/g, "");
    s = decodeEntities(s);
  }
  s = cutQuotedText(s.replace(/\r\n?/g, "\n").replace(/ /g, " "));
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > MAX_REPLY_BODY_CHARS ? s.slice(0, MAX_REPLY_BODY_CHARS - 1).trimEnd() + "…" : s;
}

/** One line of a body, for the list row. */
export function previewLine(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > REPLY_PREVIEW_CHARS ? flat.slice(0, REPLY_PREVIEW_CHARS - 1).trimEnd() + "…" : flat;
}

/**
 * Whether a message Smartlead reports is the one the CRM sent.
 *
 * The send response carries no id that the webhook later repeats, so a reply
 * sent from the Replies tab is recognised by its TEXT: Smartlead's copy is ours
 * plus, usually, the mailbox signature and a quote — so "starts with" rather
 * than equality, compared whitespace-folded. Only ever asked about unconfirmed
 * CRM rows in the same thread, which is what keeps a prefix match from being a
 * loose one.
 */
export function isSameSentText(ours: string, reported: string): boolean {
  const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = fold(ours);
  const b = fold(reported);
  return a.length > 0 && b.startsWith(a);
}

/**
 * The newest stats id in a GET /campaigns/{id}/leads/{lead_id}/message-history
 * response, or "".
 *
 * The send path's fallback for a thread whose webhooks never carried one. The
 * envelope is read defensively — live responses wrap entries in `history`, the
 * documented example in `messages` — and "newest" compares the ISO `time`
 * strings, falling back to the last entry, since the list is chronological.
 */
export function newestStatsId(data: unknown): string {
  const envelope = asObj(data);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(envelope.history)
      ? envelope.history
      : Array.isArray(envelope.messages)
        ? envelope.messages
        : [];
  let best = "";
  let bestTime = "";
  for (const raw of list) {
    const entry = asObj(raw);
    const id = first(entry.stats_id, entry.email_stats_id);
    if (!id) continue;
    const time = first(entry.time, entry.sent_at, entry.received_at);
    if (!best || time >= bestTime) {
      best = id;
      bestTime = time;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Webhook payloads
// ---------------------------------------------------------------------------

/** One message as a webhook describes it. `sentAt` is Smartlead's string, unparsed. */
export type WebhookMessage = {
  direction: ReplyDirection;
  body: string;
  sentAt: string | null;
  messageId: string | null;
  statsId: string | null;
};

export type WebhookPlan =
  | { kind: "ignore"; reason: string }
  | {
      kind: "apply";
      event: string;
      campaignId: string;
      /** Lowercased. */
      email: string;
      /**
       * EMAIL_REPLY and LEAD_CATEGORY_UPDATED create the lead and thread.
       * EMAIL_SENT only ever adds to a thread that already exists — every
       * campaign send fires it, and a thread per send would turn the inbox into
       * a copy of the campaign.
       */
      createsThread: boolean;
      /** "" means the payload did not say; the writer keeps what it has. */
      lead: { smartleadLeadId: string; firstName: string; lastName: string; companyName: string };
      /**
       * null: this payload says nothing about the category, leave it alone.
       * `sentiment` null with `name` set means the payload named the category
       * without its sentiment_type, and the webhook route resolves it through
       * GET /leads/fetch-categories.
       */
      category: { name: string | null; sentiment: StoredSentiment | null } | null;
      emailAccountId: string;
      subject: string;
      /** The payload's own stats id, kept even when no message carried a body. */
      statsId: string;
      messages: WebhookMessage[];
    };

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** A trimmed string from a string or a number; "" otherwise. */
function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** The first non-empty value among the candidates. */
function first(...values: unknown[]): string {
  for (const v of values) {
    const t = text(v);
    if (t) return t;
  }
  return "";
}

/** A raw body that is present, without trimming it (whitespace can be meaningful HTML). */
function rawBody(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function message(direction: ReplyDirection, body: string, sentAt: string, messageId: string, statsId: string): WebhookMessage | null {
  const bodyText = messageBodyText(body);
  // A message with neither words nor a time carries nothing to show or to key on.
  if (!bodyText && !sentAt) return null;
  return {
    direction,
    body: bodyText,
    sentAt: sentAt || null,
    messageId: messageId || null,
    statsId: statsId || null,
  };
}

/** The category a payload reports, or null when it reports none at all. */
function readCategory(p: Obj, leadData: Obj): { name: string | null; sentiment: StoredSentiment | null } | null {
  const nested = asObj(leadData.category);
  const topObj = asObj(p.category);
  const hasAny =
    "category" in leadData ||
    "category" in p ||
    "lead_category" in p ||
    "lead_category_name" in p;
  if (!hasAny) return null;
  const name = first(nested.name, topObj.name, p.category, p.lead_category_name, asObj(p.lead_category).name, p.lead_category);
  const sentiment = sentimentFromType(
    first(nested.sentiment_type, topObj.sentiment_type, asObj(p.lead_category).sentiment_type, p.sentiment_type),
  );
  // A category event with no name is Smartlead clearing the category.
  return { name: name || null, sentiment: name ? sentiment : null };
}

/**
 * Turn one webhook delivery into what the writer should do.
 *
 * Every event this inbox does not use is IGNORED rather than rejected: the
 * route answers 200 either way, because a non-2xx makes Smartlead retry a
 * delivery that will never be acceptable.
 */
export function planWebhook(payload: unknown): WebhookPlan {
  const p = asObj(payload);
  const event = text(p.event_type).toUpperCase();
  if (!event) return { kind: "ignore", reason: "no event_type" };
  if (event !== "EMAIL_REPLY" && event !== "LEAD_CATEGORY_UPDATED" && event !== "EMAIL_SENT") {
    return { kind: "ignore", reason: `event ${event.slice(0, 40)} is not used` };
  }

  const campaignId = first(p.campaign_id, asObj(p.campaign).id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(campaignId)) return { kind: "ignore", reason: "no usable campaign_id" };

  const leadData = asObj(p.lead_data);
  const correspondence = asObj(p.lead_correspondence);
  const email = (
    event === "LEAD_CATEGORY_UPDATED"
      ? first(p.lead_email, leadData.email, p.sl_lead_email, p.to)
      : first(p.sl_lead_email, p.lead_email, correspondence.targetLeadEmail, leadData.email, p.to_email)
  ).toLowerCase();
  if (!email || email.length > 320 || !email.includes("@")) return { kind: "ignore", reason: "no lead email" };

  const named = splitName(first(p.to_name, p.lead_name));
  const lead = {
    smartleadLeadId: first(p.sl_email_lead_id, p.lead_id, leadData.id),
    firstName: first(leadData.first_name, p.lead_first_name, named.firstName),
    lastName: first(leadData.last_name, p.lead_last_name, leadData.first_name ? "" : named.lastName),
    companyName: first(leadData.company_name, p.company_name, p.lead_company_name),
  };
  const emailAccountId = first(p.email_account_id, p.sl_email_account_id, asObj(p.email_account).id);

  const messages: WebhookMessage[] = [];
  let subject = first(p.subject);

  if (event === "EMAIL_REPLY") {
    const sent = asObj(p.sent_message);
    const reply = asObj(p.reply_message);
    // The email they answered, when the payload includes it. It may be one the
    // CRM sent, in which case the writer confirms that row rather than adding one.
    const sentMsg = message(
      "SENT",
      rawBody(sent.html, sent.text, p.sent_message_body),
      first(sent.time),
      first(sent.message_id, sent.messageId),
      first(p.stats_id),
    );
    if (sentMsg?.sentAt) messages.push(sentMsg);
    const replyMsg = message(
      "REPLY",
      rawBody(reply.html, reply.text, p.reply_body, p.preview_text),
      first(reply.time, p.time_replied, p.event_timestamp),
      first(reply.message_id, reply.messageId),
      first(p.stats_id),
    );
    if (replyMsg) messages.push(replyMsg);
  } else if (event === "LEAD_CATEGORY_UPDATED") {
    const history = Array.isArray(p.history) ? p.history : [];
    const entries = history.length ? history : p.lastReply ? [p.lastReply] : [];
    for (const raw of entries) {
      const h = asObj(raw);
      const type = text(h.type).toUpperCase();
      const direction: ReplyDirection | null = type === "REPLY" ? "REPLY" : type === "SENT" ? "SENT" : null;
      if (!direction) continue;
      const m = message(
        direction,
        rawBody(h.email_body, h.html, h.text),
        first(h.time, h.sent_time),
        first(h.message_id, h.messageId),
        first(h.stats_id),
      );
      // A history entry with no time cannot be keyed, so storing it would add it
      // again on every retry. Skipped; the conversation's other entries still land.
      if (m?.sentAt) messages.push(m);
      if (!subject) subject = first(h.subject);
    }
  } else {
    const m = message(
      "SENT",
      rawBody(p.custom_email_message, p.email_body, p.sent_message_body),
      first(p.time_sent, p.sent_time, p.event_timestamp),
      first(p.message_id),
      first(p.stats_id),
    );
    if (m?.sentAt) messages.push(m);
    subject = first(p.custom_subject, p.subject);
  }

  // Only a category event may CLEAR a category. A reply payload that carries
  // `lead_category: null` is describing the lead at the moment of the reply, and
  // Smartlead's AI categorisation often fires LEAD_CATEGORY_UPDATED first — so
  // honouring that null would wipe a sentiment that had already arrived.
  const reported = event === "EMAIL_SENT" ? null : readCategory(p, leadData);
  const category = event === "LEAD_CATEGORY_UPDATED" ? reported : reported?.name ? reported : null;

  return {
    kind: "apply",
    event,
    campaignId,
    email,
    createsThread: event !== "EMAIL_SENT",
    lead,
    category,
    emailAccountId,
    subject: subject.slice(0, 300),
    statsId: first(p.stats_id),
    messages,
  };
}
