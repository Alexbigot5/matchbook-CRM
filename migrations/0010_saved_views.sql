-- Saved views: named, reusable filters over the contacts list, backing the
-- "New view" builder on the contacts page.
--
-- The four fixed filters the page already has (the VIEWS rows, the OWNER rows,
-- the SOURCE row, the STAGE chips) are each single-axis and hardcoded. A saved
-- view is the general form: an AND of clauses over status / owner / loop, kept
-- under a name so a filter someone runs every morning survives a reload.
--
-- WHY `conditions` IS A JSON TEXT ARRAY, not a child table. Unlike
-- template_variants, conditions are never queried across views, never counted,
-- never ordered and never addressed individually — they are read back whole and
-- applied in JS by matchesConditions() in app/crm/views.ts. That is the same
-- reason contacts.loops is a JSON array rather than a contact_loops table.
--
-- They are also NEVER compiled into SQL. The field and op strings are whitelisted
-- in app/lib/validate.ts because a value outside the closed set renders as a view
-- matching nothing, not because it could reach a query — but if anyone ever moves
-- this filtering into a WHERE clause, that whitelist becomes the injection guard
-- and has to move with it.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * No index. The only read is `WHERE shared = 1 OR created_by = ?`, an OR
--     across two columns that SQLite will not serve from a single-column index
--     anyway, and a team's saved views are tens of rows. email_templates has no
--     index either, for the same stated reason.
--
--   * No per-page column. These filter contacts, and only the contacts page
--     renders them. A view that meant something different on /lifecycle would be
--     a different feature, not a column.
--
--   * No updated_at. Editing a view is not offered — delete and re-create — so
--     there is nothing for it to record.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 1 = every signed-in user sees it, 0 = only its creator. CHECKed because it
  -- is a closed numeric set, the same rule 0008 applies to `loop`; the field and
  -- op strings inside `conditions` are whitelisted in app/lib/validate.ts
  -- instead, since SQLite cannot drop a CHECK without rebuilding the table.
  shared INTEGER NOT NULL DEFAULT 1 CHECK (shared IN (0, 1)),
  -- The creator's normalized email — Viewer.email from app/lib/session.server.ts.
  -- Email rather than the display name every other table stores, because this is
  -- the column the visibility clause tests: it is the allowlist key and the only
  -- stable identifier the session exposes. It is never sent to the client; the
  -- loader resolves it into a `mine` boolean.
  created_by TEXT NOT NULL,
  -- Display name, cached for the row's caption. Never used to address anything,
  -- so it does not need to track a later rename in app/lib/allowlist.ts.
  created_by_name TEXT NOT NULL,
  -- JSON array of {field, op, value}. See the header.
  conditions TEXT NOT NULL,
  -- Ordered on, never parsed and never rendered — which is what makes the
  -- datetime('now') default safe here. It emits no timezone designator, so any
  -- column that IS later Date.parse()d must be written as an ISO string from JS
  -- instead (see the note in 0009).
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
