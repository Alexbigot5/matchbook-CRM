-- Inbound replies, pulled from Unipile (unipile.com) across email and LinkedIn.
--
-- WHAT UNIPILE IS. A unified messaging API: one key, one DSN, and a list of
-- connected "accounts" — a Gmail/Outlook mailbox, a LinkedIn session. It reads
-- `GET /emails` for the mailboxes and `GET /chats` + `GET /messages` for
-- LinkedIn, so the CRM can finally see the half of the conversation it never
-- had. Everything this app sent was already visible (Smartlead's stats sync
-- backfills sends onto contacts, migration 0015); nothing at all told it when
-- someone answered.
--
-- THE SAME BARGAIN THE SMARTLEAD TABLES MAKE. Unipile owns the accounts, the
-- mailboxes and the message bodies; this schema stores only what is ours:
--   * a per-account sync watermark, so a re-press pulls forward rather than
--     re-reading the whole mailbox, and
--   * the replies that matched a contact, because a reply is CRM history and
--     must survive an account being disconnected.
-- The account LIST is deliberately not mirrored — /settings reads it live from
-- `GET /accounts`, exactly as /smartlead's SENDERS section reads its mailboxes.
-- A cached copy would confidently render "connected" for a LinkedIn session
-- that expired an hour ago, which is the one thing an operator needs to be
-- told the truth about.
--
-- NO WEBHOOK, NO CRON. Unipile offers both; this uses neither, for the reason
-- migrations/0009 gives about Smartlead: every operation here is a button, so
-- there is no background job to reason about and no public unauthenticated
-- endpoint to defend. The watermark below is what makes pressing that button
-- cheap on the second press.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

-- Per-account sync bookkeeping. One row per Unipile account this CRM has ever
-- synced; rows are created lazily on first sync, never by connecting.
--
-- This is NOT the account list. It exists only so the next sync knows where the
-- last one stopped. An account disconnected in Unipile leaves its row behind
-- deliberately: reconnecting the same mailbox resumes rather than re-reading
-- (and re-logging) months of history onto contact timelines.
CREATE TABLE IF NOT EXISTS unipile_accounts (
  -- Unipile's own account id, opaque here. It is only ever echoed back into a
  -- query parameter, never compared or summed, so TEXT — the same reasoning as
  -- smartlead_campaigns.campaign_id. validateUnipileAccountId() in
  -- app/lib/validate.ts enforces its shape before it reaches a URL.
  account_id TEXT PRIMARY KEY,
  -- Unipile's provider type as reported: MAIL, GOOGLE_OAUTH, OUTLOOK, LINKEDIN…
  -- Cached for display only, so a row can be labelled before the live account
  -- read returns (or when Unipile is unreachable). Never used to address
  -- anything, and never trusted over the live read.
  provider TEXT NOT NULL DEFAULT '',
  -- The mailbox address or LinkedIn name, again display-only.
  display_name TEXT NOT NULL DEFAULT '',
  -- THE WATERMARK. The newest message timestamp this account has been read up
  -- to, stored as an ISO string because that is exactly what Unipile's `after`
  -- query parameter takes and what its `date`/`timestamp` fields return —
  -- round-tripping it through any other format is a chance to lose the timezone.
  --
  -- NULL means "never synced", and the first sync therefore reads only
  -- UNIPILE_FIRST_SYNC_DAYS back rather than the whole mailbox. Reading
  -- everything would mine years of unrelated correspondence for name matches
  -- and stamp replies onto contacts who answered a different conversation
  -- entirely; a bounded first read is the honest default, and pressing sync
  -- again simply moves forward from here.
  last_synced_at TEXT,
  -- One sentence about the most recent sync, so a reload still says what
  -- happened. Same device as smartlead_campaigns.last_result.
  last_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per inbound reply that matched a contact.
--
-- WHY REPLIES ARE THEIR OWN TABLE RATHER THAN JUST TOUCHPOINTS. The sync writes
-- both: a touchpoint so the reply joins the contact's timeline like every other
-- interaction, and a row here because a reply has two things a touchpoint has
-- no column for — the provider's message id, which is what makes re-pressing
-- Sync idempotent, and a read/unread state, which is what the "New replies"
-- strip on the contacts page is.
CREATE TABLE IF NOT EXISTS contact_replies (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  -- 'email' or 'linkedin' — the same two keys as CH in app/crm/data.ts, so the
  -- strip's chip and the timeline's icon are looked up from one table. CHECKed
  -- here because, unlike touchpoints.type, nothing else writes this column.
  channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  -- Which connected account saw it. Not a foreign key to unipile_accounts: that
  -- row is sync bookkeeping and may be reset, while this is history.
  account_id TEXT NOT NULL,
  -- Unipile's id for the message (an email id, or a chat message id). The real
  -- idempotency key — see the unique index below.
  provider_message_id TEXT NOT NULL,
  -- The email thread or the LinkedIn chat, kept so a future "open this
  -- conversation" affordance has something to address. Nullable: some providers
  -- return neither.
  thread_id TEXT,
  -- Email only; NULL for LinkedIn, which has no subjects.
  subject TEXT,
  -- The first UNIPILE_SNIPPET_CHARS of the plain-text body. Deliberately a
  -- snippet and not the message: this CRM is not an inbox, the card shows two
  -- lines, and storing full bodies would put every word of the team's private
  -- correspondence in a table that four people can read and a CSV export can
  -- reach.
  snippet TEXT NOT NULL DEFAULT '',
  -- Who it came from, as the provider reported them. Kept verbatim for display
  -- beside the contact's name, so a reply from a colleague on the same thread is
  -- visibly not from the contact.
  sender_name TEXT NOT NULL DEFAULT '',
  -- The address (email) or provider id (LinkedIn) the match was made on.
  sender_identifier TEXT NOT NULL DEFAULT '',
  -- WHICH RULE matched: 'email', 'linkedin-profile' or 'name'. Together with the
  -- identifier above this is the audit trail for a wrong match, and it is the
  -- half that actually explains one — 'name' is the only rule that can be
  -- confidently wrong, so being able to ask "which of these landed by name?" is
  -- the difference between finding a mis-attribution and re-deriving the
  -- matcher's reasoning by hand. Not CHECKed: the rule set is app-level and
  -- expected to grow, and validate.ts is where this codebase keeps whitelists
  -- SQLite can't later drop (see the note on template_variants.slot).
  matched_on TEXT NOT NULL DEFAULT '',
  -- When the reply was sent, as the provider reported it (ISO). Ordered on and
  -- parsed into a relative label by the loader — never by the render path.
  received_at TEXT NOT NULL,
  -- NULL while unread. Set by "Mark all read" and by the per-card dismiss, which
  -- is the only thing that takes a card off the strip: nothing auto-reads, since
  -- a reply nobody acknowledged is precisely what the strip exists to nag about.
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The real guard behind "log each reply once". The action filters on what it has
-- already stored, but two operators pressing Sync at the same moment both read
-- the same set — only this index settles it. recordReplies() uses INSERT OR
-- IGNORE against it, the same "let the index decide" discipline as
-- recordPushedLeads() and addVariant().
--
-- Keyed on (account, message) rather than the message alone: ids are unique
-- within a provider account, not across them, and the same thread read through
-- two connected mailboxes is genuinely two observations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_replies_provider
  ON contact_replies (account_id, provider_message_id);

-- The strip's query: unread first, newest first.
CREATE INDEX IF NOT EXISTS idx_contact_replies_unread
  ON contact_replies (read_at, received_at DESC);

-- The detail panel's query, and the cascade in deleteContacts().
CREATE INDEX IF NOT EXISTS idx_contact_replies_contact
  ON contact_replies (contact_id);
