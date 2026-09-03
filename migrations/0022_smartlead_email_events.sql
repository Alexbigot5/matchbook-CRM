-- One row per email Smartlead has reported, so the CRM can answer questions
-- about a campaign without asking Smartlead again.
--
-- WHAT THIS REPLACES. `GET /campaigns/{id}/statistics` returns one row per
-- email — lead_email, sequence_number, sent_time, open_time, click_time,
-- reply_time, open_count, click_count, lead_category, is_bounced,
-- is_unsubscribed, and a stats_id — and the stats sync already pages through
-- every one of them. It then threw all of it away except three timestamps: it
-- totalled sends/opens/replies by step onto template_variants (migration 0008)
-- and grouped sent_time by lead onto contacts (migration 0015). Clicks, lead
-- sentiment, bounces and unsubscribes were read over the wire and discarded, and
-- because only totals were kept there was no way to ask "how many were sent last
-- Tuesday" — /analytics' campaign chart had to approximate it from touchpoints.
--
-- Keeping the rows is what makes those questions answerable, and it costs no
-- extra API call: this is the same read, stored instead of summed.
--
-- WHY THIS DOESN'T CONTRADICT 0009's "derive, don't store". That rule is about
-- Smartlead's own CONFIGURATION — a campaign's status, schedule and sequence
-- numbering, all of which someone can change in Smartlead's UI at any moment, so
-- a mirror here would confidently render something false. These rows are the
-- opposite kind of thing: an email that was sent on a date and opened at a time
-- is a historical fact that cannot change afterwards. It is the same distinction
-- 0021 draws when it stores replies but refuses to mirror the account list.
--
-- STATS_ID IS THE IDEMPOTENCY KEY. Smartlead assigns one per email row, so a
-- re-sync of the same email is recognised as the same email no matter how the
-- pages came back — the same discipline as smartlead_leads' unique index and
-- contact_replies' (account_id, provider_message_id). It is also what lets this
-- table be written PAGE BY PAGE rather than all-or-nothing: unlike the absolute
-- template counters, a short read stores fewer emails, never wrong ones, and the
-- next press picks up the rest. The upsert refreshes the engagement columns,
-- because an email sent yesterday and opened today comes back with a new
-- open_time on the next sync.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * No contact_id. Everything /analytics asks of this table is per campaign or
--     per sequence step, and the one per-person question ("has this contact been
--     emailed") is already answered by the touchpoints migration 0015 writes.
--     Denormalising a second copy of the contact link would create two answers
--     that can disagree.
--
--   * No subject or body. The copy has one home (template_variants) and
--     0012 explains why a second one drifts.
--
--   * No derived rates. Every rate is computed in app/crm/campaigns.ts from
--     these columns, exactly as ab.ts computes its own from the four counters,
--     so a corrected sync immediately corrects the figure.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS smartlead_email_events (
  -- Smartlead's own id for this statistics row. TEXT because it is an opaque
  -- handle here, never compared or summed — the same reasoning as
  -- smartlead_campaigns.campaign_id. A row that arrives without one is dropped
  -- by the writer rather than given a synthetic key: a synthetic key would make
  -- every sync insert the same email again.
  stats_id TEXT PRIMARY KEY,
  -- Denormalised rather than derived through smartlead_campaigns, for the reason
  -- smartlead_leads gives: a loop can be rebound to a different campaign, and
  -- these rows record what happened WHERE.
  campaign_id TEXT NOT NULL,
  -- Lowercased at write time so counting distinct leads is a plain COUNT
  -- DISTINCT rather than a case-folding one.
  lead_email TEXT NOT NULL,
  -- Smartlead's 1-based step number. Nullable: rows occasionally arrive without
  -- one, and dropping them would under-report the campaign's send volume.
  sequence_number INTEGER,
  -- The four timestamps, stored verbatim as Smartlead reports them (ISO with a
  -- Z). NULL means it hasn't happened. Ordered and date-bucketed on as text —
  -- see the index note below.
  sent_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  replied_at TEXT,
  -- Raw event counts, kept because they are the only way to tell one lead who
  -- opened eight times from eight leads who opened once. Every figure /analytics
  -- shows is the UNIQUE one (Smartlead's own convention, and what its UI
  -- reports), so these are stored and not yet read — the honest place for a
  -- number we have and don't display, rather than throwing it away and needing a
  -- backfill later.
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  -- The lead's sentiment category as Smartlead names it ("Interested", "Not
  -- Interested", and whatever else the team has created). Stored verbatim
  -- because the category set is the customer's, not ours.
  lead_category TEXT,
  -- Whether that category is a POSITIVE one, resolved at sync time from
  -- `sentiment_type` on GET /leads/fetch-categories. Resolved rather than
  -- inferred from the name: "Interested" happens to be built-in and positive,
  -- but a team's own "Warm intro" is positive too and only the API knows it.
  --
  -- 0 when the category list could not be read, in which case the sync says so
  -- in its result line rather than the page quietly reporting zero positives as
  -- if that were the finding. The next successful sync corrects it.
  --
  -- NOTE this is a property of the LEAD, repeated on each of their rows. Every
  -- read of it must therefore count DISTINCT lead_email, or a lead who received
  -- four emails counts as four positive replies.
  is_positive INTEGER NOT NULL DEFAULT 0 CHECK (is_positive IN (0, 1)),
  is_bounced INTEGER NOT NULL DEFAULT 0 CHECK (is_bounced IN (0, 1)),
  is_unsubscribed INTEGER NOT NULL DEFAULT 0 CHECK (is_unsubscribed IN (0, 1)),
  -- When this CRM last saw the row. Bookkeeping only: it says whether a figure
  -- is stale, and is never parsed into a label (the campaign's stats_synced_at
  -- is what the page prints).
  synced_at TEXT NOT NULL
);

-- The daily chart's read: one campaign, bucketed by the UTC date prefix of each
-- timestamp. Bucketing is substr(sent_at, 1, 10) rather than date(sent_at)
-- because Smartlead's values are ISO-with-Z and SQLite's date() would have to
-- parse them; the prefix IS the UTC day, which is exactly the day
-- buildAnalyticsLabels() builds its axis from. Both sides bucket on UTC
-- midnight — change one and change the other.
CREATE INDEX IF NOT EXISTS idx_smartlead_events_campaign_sent
  ON smartlead_email_events (campaign_id, sent_at);

-- The step table's read: totals per sequence step for one campaign.
CREATE INDEX IF NOT EXISTS idx_smartlead_events_campaign_seq
  ON smartlead_email_events (campaign_id, sequence_number);
