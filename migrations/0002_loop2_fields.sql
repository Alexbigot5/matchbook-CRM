-- Loop 2 provenance fields, added on top of the initial schema.
--
--   source              — the community/event a Loop 2 contact came from (e.g. "Newtopia")
--   resumed_to_loop1_at — ISO timestamp a Loop 2 contact was resumed into Loop 1
--
-- Kept as a separate migration (rather than folding into 0001) so the chain is
-- portable: databases created before these columns existed get them via this
-- ALTER, while fresh databases build 0001 then 0002 in order. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so this must run exactly once per database — which
-- Wrangler guarantees via the `d1_migrations` table.

ALTER TABLE contacts ADD COLUMN source TEXT;
ALTER TABLE contacts ADD COLUMN resumed_to_loop1_at TEXT;
