-- One-off campaigns: a single email to a loaded list of leads, sent once.
--
-- Migration 0009 made "one Smartlead campaign per loop" a schema fact by keying
-- smartlead_campaigns on `loop`, and everything built on top of it — the sequence
-- builder (0012), the stats sync (0015, 0022), /analytics' per-loop cards — reads
-- that key. It is the right shape for the thing it models: an always-on outbound
-- sequence that runs for months and whose steps are attributed back to templates.
--
-- It cannot model the other thing this CRM's operator does, which is send ONE
-- email to a list, once. "We're at Expo West next week" is not a sequence, is not
-- a loop, has no second step, and will never be sent again. Expressed through a
-- loop binding it would have to re-point Loop 2's campaign at a throwaway, wipe
-- its sequence, blast, and then put everything back — losing the loop's own
-- history in `smartlead_campaigns` on the way through.
--
-- So one-offs get their own table, deliberately NOT keyed on loop, and each row
-- is its own campaign. There can be as many as someone sends.
--
-- WHAT IS SHARED WITH THE LOOP CAMPAIGNS, on purpose:
--
--   * `smartlead_leads`. Its unique index is (contact_id, campaign_id), so a
--     contact can be in a one-off and in a loop campaign at once — which is the
--     whole point, since an event blast goes to people who are already
--     sequencing. Recording the push here is also what makes the sends land back
--     on contacts: listCampaignLeadState() and recordContactSends() (0015) are
--     keyed on campaign_id and know nothing about loops, so they work unchanged.
--
--   * `smartlead_email_events` (0022). Same argument: keyed on campaign_id and
--     stats_id, so a one-off's per-email rows store exactly like a loop's.
--
-- WHAT IS DELIBERATELY NOT SHARED:
--
--   * Template counters. `recordVariantStats` writes ABSOLUTE lifetime totals per
--     (template, slot). A one-off usually reuses a template that a loop campaign
--     is also sending, so writing the blast's numbers there would replace the
--     sequence's totals with the blast's — the same reason 0012's duplicate steps
--     are skipped, arriving from a different direction. The one-off sync
--     therefore does the two per-row halves (store the emails, mark the contacts)
--     and leaves the counters alone, and the page says so.
--
-- WHAT IS NOT STORED, following 0009's rule: no status, no schedule, no copy. The
-- campaign's live state belongs to Smartlead and anyone can change it there;
-- `template_id`/`variant_slot` are a record of what was uploaded at creation, not
-- a mirror of what the campaign holds now — which is why editing that template
-- afterwards changes nothing about a one-off that has already gone out.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS smartlead_one_offs (
  id TEXT PRIMARY KEY,
  -- Smartlead's campaign id. UNIQUE rather than the primary key for the reason
  -- every other table here mints its own: the row is created the instant
  -- Smartlead hands the id back, before the sequence is uploaded or a single
  -- lead is pushed, so the CRM can never end up having created a campaign it has
  -- no record of. The uniqueness is what stops a retry adopting the same
  -- campaign twice.
  campaign_id TEXT NOT NULL UNIQUE,
  campaign_name TEXT NOT NULL,
  -- The template and variant whose copy was uploaded as the campaign's single
  -- step. NOT a foreign key, and deliberately: a one-off is a historical fact
  -- about an email that was sent, and deleting the template it was written from
  -- must not be blocked by — or erase — the record of the send. Rendered as a
  -- name only when the template still exists.
  template_id TEXT,
  variant_slot TEXT,
  -- How the recipients were chosen, as a label for the row ("All contacts",
  -- or a saved view's name). The view id is not stored: a one-off is sent once,
  -- so re-resolving the audience later would answer a question nobody asks, and
  -- a deleted view would leave a dangling reference to it.
  audience TEXT NOT NULL DEFAULT '',
  -- Leads Smartlead accepted. Written as the push proceeds, so a partial push
  -- reports what actually went in rather than what was planned.
  lead_count INTEGER NOT NULL DEFAULT 0,
  -- Same ISO-string-from-JS convention as smartlead_campaigns, and for the same
  -- reason: the loader Date.parse()s this to build a label, and SQLite's
  -- datetime('now') has no timezone designator.
  stats_synced_at TEXT,
  -- One sentence about the most recent operation, so a reload still says what
  -- happened. Mirrors smartlead_campaigns.last_result (0011).
  last_result TEXT,
  created_by TEXT,
  -- Ordered on, never parsed, so the column default is safe here — the same
  -- distinction smartlead_campaigns draws.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The only read is "every one-off, newest first" over a table that grows by a
-- row per blast — tens, not thousands. No index, for the reason 0012 gives.
