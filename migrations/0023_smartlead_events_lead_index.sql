-- One index, so "what has this contact opened" is answerable on every page load.
--
-- WHY. migrations/0022 stores one row per email Smartlead reported, and its two
-- indexes are both keyed on campaign_id — they serve /analytics, which always
-- asks about one campaign. The contacts page asks the opposite question: for
-- EVERY contact in the book, how far through the sequence did they open, and did
-- they answer. That is a GROUP BY lead_email across every campaign, and without
-- an index it is a full table scan on the busiest loader in the app
-- (listContacts, which /, /lifecycle, /analytics, /templates, /smartlead,
-- /settings and the machine API all run).
--
-- The column order is the grouping key first, then the three values the read
-- needs, which makes it a COVERING index: SQLite answers listContacts' engagement
-- query from the index alone and never touches the table. That is the whole
-- reason opened_at and replied_at are in here rather than a bare (lead_email) —
-- they are not filtered on cheaply, they are read.
--
-- No new columns and no new writes: the sync's upsert maintains this like any
-- other index. Applied via Wrangler's D1 migrations:
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE INDEX IF NOT EXISTS idx_smartlead_events_lead_engagement
  ON smartlead_email_events (lead_email, sequence_number, opened_at, replied_at);
