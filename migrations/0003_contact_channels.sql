-- Contact-info channels, added on top of the initial schema + loop2 fields.
--
--   email     — primary email address (rendered as a mailto: link in the detail panel)
--   phone     — phone number (rendered as a tel: link)
--   linkedin  — LinkedIn URL or handle (rendered as an external link)
--
-- Kept as a separate migration (rather than folding into 0001) so the chain is
-- portable, matching 0002_loop2_fields.sql. SQLite has no `ADD COLUMN IF NOT
-- EXISTS`, so each runs exactly once per database — which Wrangler guarantees via
-- the `d1_migrations` table.

ALTER TABLE contacts ADD COLUMN email TEXT;
ALTER TABLE contacts ADD COLUMN phone TEXT;
ALTER TABLE contacts ADD COLUMN linkedin TEXT;
