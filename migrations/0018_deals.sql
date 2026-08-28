-- Deals, and the (at most two) stakeholder contacts attached to each.
--
-- A DEAL'S STAGE IS NOT A CONTACT'S STATUS. `contacts.status` stays exactly what
-- it has always been: a per-person engagement marker (New → Contacted → Replied
-- → Meeting booked → Won → Dead) that the contacts table, the detail panel and
-- the /lifecycle board all read, and that this migration does not touch. A deal
-- carries its OWN stage, and once a deal exists that stage is the official
-- pipeline position — the two are allowed to disagree, and will: a company can
-- be at "Negotiation" while the champion you have been emailing is still
-- "Replied", and the second contact on the deal has a status of their own.
-- Collapsing them into one column would mean either losing per-person state or
-- rewriting six people's statuses every time a deal moves.
--
-- This is why DEAL_STAGES in app/crm/data.ts is a separate constant from
-- STATUSES rather than a reuse of it. The two vocabularies are free to diverge.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  -- NOT NULL, unlike contacts.company_id. A contact without a company is an
  -- ordinary influencer row; a deal without one is not a deal.
  company_id TEXT NOT NULL REFERENCES companies(id),
  -- No CHECK, deliberately, and for the same reason 0010 whitelists its view
  -- fields in app/lib/validate.ts instead: SQLite cannot drop or alter a CHECK
  -- without rebuilding the table, and a pipeline gains and loses stages far more
  -- often than a schema should be rewritten. isValidDealStage() in validate.ts
  -- is the gate, derived from DEAL_STAGES so the two cannot drift.
  stage TEXT NOT NULL DEFAULT 'New',
  -- Whole currency units, nullable: a deal usually has no number on it until
  -- somebody has quoted one, and 0 is a real (bad) answer that must not be how
  -- "not priced yet" is spelled.
  value INTEGER,
  -- ISO date ('2026-09-30'), not a timestamp — a close date is a day, and the
  -- hour would be noise nobody sets.
  expected_close_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set when the deal reaches a terminal stage; NULL while it is live. Written
  -- from JS as a full ISO string, NOT via datetime('now'), because unlike
  -- created_at this one is read back and turned into a label — see 0009.
  closed_at TEXT
);

-- The board groups by stage; the "Also at [Company]" block looks up by company.
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);

-- Stakeholders. A join table with a hard ceiling of two rows per deal.
--
-- WHY NOT AN OPEN-ENDED LIST. The shape being modelled is "the person driving
-- this and, if there is one, their counterpart" — a champion and an economic
-- buyer. An unbounded list looks more general but is strictly worse here: it has
-- no answer to "who do I chase", it renders as a pile of avatars nobody prunes,
-- and it pushes the primary/secondary distinction that actually matters into a
-- nullable ordering column.
--
-- The ceiling is enforced by UNIQUE(deal_id, role) over a two-value CHECK, so
-- the database itself permits at most one primary and one secondary per deal.
-- addContactToDeal() in app/lib/crm.server.ts checks the same rule first so the
-- UI gets a sentence instead of a constraint violation, but the constraint is
-- what makes it true — a second writer racing the first still cannot produce a
-- deal with two primaries.
CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id TEXT NOT NULL REFERENCES deals(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  -- Closed two-value set that will never grow (a third slot would be the
  -- open-ended list this table exists to refuse), so unlike deals.stage a CHECK
  -- is the right call — the same reasoning 0010 applies to `shared`.
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One row per person per deal: the same contact cannot be both stakeholders.
  PRIMARY KEY (deal_id, contact_id),
  -- One primary and one secondary, at most, per deal. This is the ceiling.
  UNIQUE (deal_id, role)
);

-- "Which deals is this contact on" — the reverse of the PK's leading column,
-- which SQLite cannot serve from the primary key index.
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON deal_contacts(contact_id);
