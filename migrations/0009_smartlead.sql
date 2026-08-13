-- Smartlead integration state: which Smartlead campaign each loop is bound to,
-- and which contacts have already been handed to it.
--
-- Smartlead (smartlead.ai) is the sending tool this CRM has always implied but
-- never named: nothing here sends email, so `template_variants.sends/opens/...`
-- were typed in by hand or pushed through /api/hyperagent by "an external sending
-- tool". These two tables are the whole persistent footprint of wiring that tool
-- up — everything else about a campaign lives in Smartlead and is read live.
--
-- ONE CAMPAIGN PER LOOP. Loop 1 (always-on outbound) and Loop 2 (event blitz)
-- each map to exactly one Smartlead campaign, and every non-concluded template on
-- that loop becomes one step of that campaign's sequence, ordered by its existing
-- `send_day`. That is why `loop` is the primary key below rather than a column
-- with a unique index bolted on: the binding is one-to-one by definition, so the
-- schema states it instead of app code defending it.
--
-- What is deliberately NOT stored here:
--
--   * No template -> seq_number mapping table. The step order is DERIVED from
--     send_day on every push and on every stats read, by the same pure function
--     (buildSequencePlan in app/crm/smartlead-map.ts). This is the same choice
--     app/crm/lifecycle.ts makes about stages: derive from the column that is
--     already the source of truth, and there is nothing to keep in sync. Editing a
--     template's send_day moves its step by itself, with no migration and no
--     repair job.
--
--   * No mirror of the campaign's status or schedule. Smartlead owns those, and
--     someone can pause a campaign in Smartlead's own UI at any time. A cached
--     copy here would confidently render "running" for a campaign that is not, so
--     the page reads them live and shows nothing when Smartlead is unreachable.
--
--   * No Smartlead numeric lead_id on smartlead_leads. The add-leads response does
--     not reliably carry per-lead ids, and every operation this app performs
--     addresses a lead by campaign + email anyway.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS smartlead_campaigns (
  -- 1 = always-on outbound, 2 = event/community blitz. Same CHECK as
  -- email_templates.loop: the domain has exactly two loops and every consumer
  -- hardcodes both. As the PRIMARY KEY it also enforces the one-campaign-per-loop
  -- rule, so bindCampaign() can be a plain upsert with no read-modify-write race.
  loop INTEGER PRIMARY KEY CHECK (loop IN (1, 2)),
  -- Smartlead's own campaign id. Stored as TEXT because it is an opaque handle
  -- here — it is only ever echoed back into a URL path, never compared or summed.
  -- It is digits in practice, and validateCampaignId() in app/lib/validate.ts
  -- enforces that before it reaches a URL.
  campaign_id TEXT NOT NULL,
  -- Cached for display only, so the page can name the campaign before the live
  -- read returns (or when Smartlead is down). Never used to address anything.
  campaign_name TEXT NOT NULL DEFAULT '',
  -- "Last time we successfully did X" markers, shown on the page so the operator
  -- can tell a campaign that was set up from one that was set up and then had its
  -- copy changed underneath it. Nullable: null means "never".
  sequence_pushed_at TEXT,
  leads_pushed_at TEXT,
  stats_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS smartlead_leads (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  -- Denormalised rather than derived through smartlead_campaigns, on purpose: a
  -- loop can be rebound to a different campaign, and these rows record what was
  -- pushed WHERE. Joining through the binding would retroactively claim the old
  -- pushes belong to the new campaign and suppress a legitimate re-push.
  campaign_id TEXT NOT NULL,
  -- The address as it was pushed. Kept alongside contact_id because the import
  -- direction dedupes on email (an inbound Smartlead lead has no CRM id), and
  -- because a contact's email can be edited after the push.
  email TEXT NOT NULL,
  pushed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The real guard behind "push only the contacts that aren't in the campaign yet".
-- The action filters on the already-pushed set it reads, but two operators
-- clicking Push at the same time both read the same set; this index is what makes
-- the second write a no-op instead of a duplicate row. recordPushedLeads() uses
-- INSERT OR IGNORE against it, the same "let the index decide" discipline as
-- addVariant() in app/lib/crm.server.ts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_smartlead_leads_contact_campaign
  ON smartlead_leads (contact_id, campaign_id);

-- Covers both reads the page performs per campaign: the pushed-email set used to
-- dedupe an inbound import, and the pushed-contact-id set used to size the next
-- push.
CREATE INDEX IF NOT EXISTS idx_smartlead_leads_campaign
  ON smartlead_leads (campaign_id);
