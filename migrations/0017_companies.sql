-- Companies, normalized out of the free-text `contacts.company` column.
--
-- WHY A TABLE AT ALL. `contacts.company` is a string typed once per contact, so
-- "Halcyon Labs", "Halcyon Labs Inc" and "halcyon labs" are three companies as
-- far as the database is concerned. That was survivable while a company was only
-- ever a label under a contact's name. It stops being survivable the moment a
-- deal hangs off one: a deal has to belong to exactly one company, and grouping
-- deals by a string nobody ever spelled the same way twice produces a pipeline
-- that double-counts.
--
-- `normalized_name` is the identity; `name` is what gets rendered. The pair is
-- the same split `contacts.name` vs. the normalizeName() index in
-- app/crm/data.ts already uses for cross-owner duplicate detection — display
-- keeps the capitalization someone typed, matching does not care about it.
-- UNIQUE on the normalized column is what makes findOrCreateCompanyByName in
-- app/lib/crm.server.ts a real find-or-create rather than an insert that hopes.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * `contacts.company` is NOT dropped, and NOT backfilled from this table.
--     Every existing read path (the contacts table cell, the detail header, the
--     CSV export, the brand-directory match in 0016) reads that column, and a
--     contact with no company_id — which is every contact whose company string
--     is blank — must keep rendering exactly as it does today. The two columns
--     coexist: `company` is display and legacy, `company_id` is the join key.
--
--   * No domain column. The directory in scripts/brand-directory.csv matches on
--     brand name, not domain, so a domain here would be empty for the whole
--     book on day one and would immediately become a second identity to keep in
--     step with the first.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  -- Display form: whatever spelling won the race to create the row. The
  -- backfill in 0019 picks the most common spelling in the contact book.
  name TEXT NOT NULL,
  -- Identity. trim + lower + internal whitespace collapsed, mirroring
  -- normalizeName() in app/crm/data.ts. See 0019 for the SQL that reproduces it.
  normalized_name TEXT UNIQUE NOT NULL,
  -- Ordered on, never parsed and never rendered, which is what makes the
  -- datetime('now') default safe here (it emits no timezone designator — see
  -- the note in 0009 about columns that are later Date.parse()d).
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nullable with no default, and no backfill obligation: a contact whose company
-- string is blank — influencer handles and test rows, roughly a third of the
-- book per 0016's note — legitimately has no company, and NULL is the honest
-- answer there rather than a placeholder row in `companies`.
--
-- SQLite permits REFERENCES in ADD COLUMN only when the new column's default is
-- NULL, which this one's is.
ALTER TABLE contacts ADD COLUMN company_id TEXT REFERENCES companies(id);

-- The one read this column has: "who else is at this company", from
-- listContactsAtCompany. Unindexed it is a full scan of the contact book on
-- every detail-panel open.
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
