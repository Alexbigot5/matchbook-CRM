-- One-time migration for existing databases that already hold contacts data.
-- schema.sql now includes these columns in its CREATE TABLE, so fresh databases
-- get them automatically — but `CREATE TABLE IF NOT EXISTS` is a no-op on an
-- existing table, and SQLite has no `ADD COLUMN IF NOT EXISTS`, so run these
-- ALTERs exactly once against a DB that already has the `contacts` table.
--
--   npx wrangler d1 execute crm-db --local  --file=./migrations/001_loop2_fields.sql
--   npx wrangler d1 execute crm-db --remote --file=./migrations/001_loop2_fields.sql
--
-- If the DB has no real data yet, dropping and re-running schema.sql is simpler.

ALTER TABLE contacts ADD COLUMN source TEXT;
ALTER TABLE contacts ADD COLUMN resumed_to_loop1_at TEXT;
