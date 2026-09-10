-- The Replies inbox on /analytics: Smartlead replies, stored as conversations
-- the CRM can show and answer.
--
-- WHAT WAS MISSING. Everything Smartlead tells this CRM about a reply before now
-- is a TIMESTAMP: smartlead_email_events.replied_at (migration 0022), plus the
-- lead's category. No words. A rep who wanted to read an answer, or send one,
-- had to leave for Smartlead's master inbox. These three tables hold what that
-- inbox holds for the replies this team cares about — the lead, the thread, and
-- the messages in it — and the Replies tab reads nothing else.
--
-- THE FIRST INBOUND WEBHOOK. Migrations 0009 and 0021 both say "no webhook, no
-- cron", because every operation was a button and so there was no public
-- endpoint to defend. An inbox is the thing a button cannot do: a reply that only
-- appears when somebody remembers to press Sync is a reply that sits unread over
-- a weekend. So these rows are written by POST /api/smartlead/webhook
-- (EMAIL_REPLY, LEAD_CATEGORY_UPDATED and, optionally, EMAIL_SENT), guarded by a
-- shared secret in the URL — Smartlead does not sign its webhooks, so the secret
-- is the whole authentication story and SMARTLEAD_WEBHOOK_SECRET is required for
-- the endpoint to accept anything at all.
--
-- WHY THIS DOESN'T CONTRADICT 0009's "derive, don't store". Same distinction
-- 0021 and 0022 draw: a message somebody wrote on a date is history, not
-- Smartlead configuration, and it cannot change underneath us.
--
-- WHY SMARTLEAD ONLY. contact_replies (0021) is the Unipile inbox across
-- mailboxes and LinkedIn, matched onto contacts. This is not that and must not
-- grow into it: every row here came from a Smartlead campaign, which is why no
-- table carries a channel column.
--
-- WHY NOT A contact_id. A Smartlead lead need not be a CRM contact — leads are
-- uploaded into Smartlead directly too — and a reply from someone outside the
-- book still needs answering. The contact is matched at READ time on the
-- lowercased address, the same link 0022 makes, and only when exactly one
-- contact holds it (the reason app/crm/unipile-map.ts gives: a wrong match puts
-- a stranger's words under someone's name).
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

-- One row per (campaign, lead address). Named for what it is — a lead that has
-- written back — so it cannot be mistaken for smartlead_leads (0009), which is
-- the CRM's record of contacts it PUSHED and is keyed on contact_id.
CREATE TABLE IF NOT EXISTS smartlead_reply_leads (
  id TEXT PRIMARY KEY,
  -- TEXT for the reason every Smartlead id in this schema is TEXT: an opaque
  -- handle, only ever echoed back into a URL path.
  campaign_id TEXT NOT NULL,
  -- Lowercased at write time, so the unique index below and the contact match
  -- are plain equality.
  email TEXT NOT NULL,
  -- Smartlead's own lead id. Nullable: EMAIL_REPLY payloads do not reliably carry
  -- it, and a reply is worth storing without it. Needed only for the send path's
  -- message-history fallback.
  smartlead_lead_id TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  -- The category as Smartlead names it ("Interested", a team's own "Warm
  -- intro"), verbatim, for the same reason 0022 stores lead_category verbatim.
  category TEXT,
  -- The category's sentiment_type, folded to three values so the Replies tabs
  -- are an indexed equality rather than a match on a name the team invented.
  -- Resolved from the webhook's own `category.sentiment_type`, or from GET
  -- /leads/fetch-categories when a payload names the category without it.
  -- NULL means uncategorized or unresolved: such a lead is in neither tab, and
  -- the tab's caption counts them so they are never silently invisible.
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The upsert key. Webhooks are retried, and EMAIL_REPLY and
-- LEAD_CATEGORY_UPDATED both describe the same lead — this is what makes the
-- second one an update.
CREATE UNIQUE INDEX IF NOT EXISTS idx_smartlead_reply_leads_campaign_email
  ON smartlead_reply_leads (campaign_id, email);

-- The tab filter and its counts.
CREATE INDEX IF NOT EXISTS idx_smartlead_reply_leads_sentiment
  ON smartlead_reply_leads (sentiment);

-- One conversation per lead. Smartlead threads a campaign's emails to one lead
-- into one conversation, so this is 1:1 by construction — hence UNIQUE lead_id.
CREATE TABLE IF NOT EXISTS smartlead_threads (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL UNIQUE REFERENCES smartlead_reply_leads(id),
  -- Denormalised from the lead for the send path, which needs it in the URL.
  campaign_id TEXT NOT NULL,
  -- The mailbox the conversation runs through, when the payload says. Display
  -- and diagnosis only; Smartlead picks the sending mailbox from the stats id.
  email_account_id TEXT,
  -- What POST /campaigns/{id}/reply-email-thread addresses: the stats id of the
  -- newest email in the thread, and the RFC Message-ID of the newest reply so the
  -- answer threads under it in the lead's mail client.
  latest_email_stats_id TEXT,
  latest_reply_message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  -- When the lead last wrote. NULL until a REPLY message is stored: an
  -- EMAIL_SENT or a category change can create the thread first, and a thread
  -- the lead never wrote in is not a reply and is not listed.
  last_reply_at TEXT,
  -- When THIS CRM last stored a new reply, by our own clock — not Smartlead's
  -- message time. "Mark all read" compares against this, because a reply written
  -- at 10:00 can be delivered at 10:20 (mailbox polling, a retried webhook), and
  -- comparing message times would clear it as though the rep had seen it.
  last_received_at TEXT,
  -- Newest message of either direction, ISO with a Z. The list's sort key.
  updated_at TEXT NOT NULL,
  -- Cleared whenever a NEW reply lands (not on a retried webhook), set when the
  -- thread is opened, answered, or swept by "Mark all read".
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  -- REPLY messages already accounted for. The webhook writer compares a fresh
  -- count against this to decide "new reply → unread", which — unlike trusting
  -- one delivery's own inserts — still works when a delivery stored a reply,
  -- failed before updating the thread, and was retried.
  reply_count INTEGER NOT NULL DEFAULT 0,
  -- The rep's flag. Turning it on ALSO moves a uniquely matched contact to
  -- "Meeting booked" (from New/Contacted/Replied only); turning it off never
  -- moves a contact back. contacts.status stays the pipeline's source of truth —
  -- this column only says which conversation produced the booking.
  meeting_booked INTEGER NOT NULL DEFAULT 0 CHECK (meeting_booked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_smartlead_threads_updated
  ON smartlead_threads (updated_at DESC);

CREATE TABLE IF NOT EXISTS smartlead_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES smartlead_threads(id),
  -- Smartlead's own words for the two directions, as its history payload
  -- spells them.
  direction TEXT NOT NULL CHECK (direction IN ('SENT', 'REPLY')),
  -- PLAIN TEXT, flattened from Smartlead's HTML at write time with quoted
  -- history cut. Never HTML: the page renders it as text, so a crafted reply
  -- cannot put markup in front of a rep. (0021 keeps a snippet only because that
  -- strip is not an inbox; this page is one, and needs the message.)
  body TEXT NOT NULL DEFAULT '',
  -- ISO with a Z, normalised at write time so ordering by text is ordering by
  -- time.
  sent_at TEXT NOT NULL,
  -- The RFC Message-ID, when Smartlead reports one.
  message_id TEXT,
  stats_id TEXT,
  -- THE IDEMPOTENCY KEY, unique per thread. The direction plus the send time to
  -- the second — not message_id, which EMAIL_REPLY and LEAD_CATEGORY_UPDATED do
  -- not both carry, so keying on it stored every reply twice. A row sent from
  -- the CRM is keyed `crm:<uuid>` until Smartlead echoes it back.
  dedupe_key TEXT NOT NULL,
  -- 'smartlead' for anything a webhook delivered, 'crm' for a reply sent from
  -- the Replies tab.
  origin TEXT NOT NULL CHECK (origin IN ('smartlead', 'crm')),
  -- Only a 'crm' row moves through these:
  --   sending    reserved before the Smartlead call; hidden from the page, and
  --              deleted if Smartlead refuses the send
  --   sent       Smartlead accepted it; shown, captioned as unconfirmed
  --   confirmed  a webhook carried the same message back
  -- A 'smartlead' row is confirmed on arrival.
  delivery TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (delivery IN ('sending', 'sent', 'confirmed')),
  -- The CRM user who sent it. NULL for anything Smartlead sent on its own.
  sent_by TEXT,
  -- Generated by the browser per draft. The partial unique index below is what
  -- turns a double-click or a retried request into a refusal rather than a
  -- second real email.
  client_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_smartlead_messages_dedupe
  ON smartlead_messages (thread_id, dedupe_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_smartlead_messages_client_key
  ON smartlead_messages (thread_id, client_key)
  WHERE client_key IS NOT NULL;

-- The thread view, and the list's latest-message preview.
CREATE INDEX IF NOT EXISTS idx_smartlead_messages_thread_sent
  ON smartlead_messages (thread_id, sent_at);
