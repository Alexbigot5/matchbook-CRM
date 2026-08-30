-- Industry tags, derived from a contact's `category` at the moment it is created.
--
-- WHY A TABLE AND NOT MORE COLUMNS. `contacts.category` is one free-text string
-- from the brand directory, and it is sometimes compound: "Food and Bev" is one
-- industry, but "Beauty;Wellness" is two. Filtering by industry over a column
-- that sometimes holds two answers means LIKE '%;%' matching, which cannot tell
-- "Pet" from "Pet Pharma" and gets slower with every row. A join table answers
-- "everyone tagged Beauty" exactly, and lets one contact carry both halves of a
-- compound value without either being second-class.
--
-- THIS MIGRATION TOUCHES NO EXISTING ROW. Both tables are created empty and stay
-- empty until something new is created. There is deliberately no backfill pass
-- over the 639 contacts already in the CRM, and no UPDATE anywhere in this file:
-- tags are populated only by the three paths that write a brand-new contact
-- (manual add, CSV import, Origami prospecting), all of which funnel through
-- createContact / createManyContacts in app/lib/crm.server.ts. An existing
-- contact therefore has zero tag rows and renders exactly as it does today,
-- which is the intended end state, not a gap waiting on a follow-up script.
--
-- The consequence worth stating plainly: for a while most of the contact book
-- will have no tags. That is why the sidebar's Tags filter is added ALONGSIDE
-- the existing category-group condition in app/crm/views.ts rather than
-- replacing it — a filter that only sees new contacts cannot be the only way to
-- slice the book by industry.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  -- The display spelling, as first seen. "Food and Bev" renders with that
  -- casing forever, even if a later import spells it "food and bev".
  name TEXT NOT NULL,
  -- Identity. Produced by normalizeName() in app/crm/data.ts (trim + lowercase +
  -- collapsed whitespace) — the SAME rule `companies.normalized_name` uses, so
  -- the two tables agree on when two strings are one thing. UNIQUE is what makes
  -- findOrCreateTag's read-then-insert safe: a concurrent import racing the same
  -- new tag loses here rather than minting a duplicate, and the retry re-reads
  -- whichever row won.
  normalized_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  -- One row per (contact, tag). The composite PK is the idempotency guarantee:
  -- re-running a sync for a contact cannot double-tag it, so INSERT OR IGNORE is
  -- safe to repeat rather than needing a pre-check.
  PRIMARY KEY (contact_id, tag_id)
);

-- "Which contacts carry this tag" — the reverse of the PK's leading column,
-- which SQLite cannot serve from the primary key index. Same reasoning as
-- idx_deal_contacts_contact in 0018.
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);
