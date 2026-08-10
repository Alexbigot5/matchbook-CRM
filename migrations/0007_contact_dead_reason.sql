-- Why a deal died, captured when a contact's status is set to Dead.
--
--   dead_reason — one of the DEAD_REASONS whitelist in app/lib/validate.ts, or
--                 NULL when the person skipped the prompt.
--
-- Nullable with no default on purpose: contacts marked Dead before this column
-- existed keep NULL, and the analytics panel reports them as "Unspecified"
-- rather than inventing a reason for them. Cleared whenever a contact moves off
-- Dead, so the value never outlives the status that produced it.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so this must run exactly once per
-- database — which Wrangler guarantees via the `d1_migrations` table.

ALTER TABLE contacts ADD COLUMN dead_reason TEXT;
