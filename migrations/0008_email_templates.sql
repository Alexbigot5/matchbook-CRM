-- Email templates and their A/B variants, backing the /templates page.
--
-- Why two tables rather than a pair of `variant_b_subject`/`variant_b_sends`
-- columns on one: the page treats A and B symmetrically — same metrics row, same
-- promote button, same remove affordance — and a template may legitimately have
-- only A. One row per variant keeps the copy, the counters and the "is this the
-- default" flag on the same grain as the thing being measured, and lets
-- listTemplates() reuse the parent+children read listContacts() already uses
-- (Promise.all of two SELECTs, children grouped into a Map).
--
-- Metrics are STORED COUNTERS, not events. Nothing in this app sends email or
-- tracks opens, so an external sending tool pushes absolute lifetime totals
-- through /api/hyperagent (op: recordTemplateStats). Absolute rather than
-- incremental on purpose: the caller has no dedupe key and Workers retries
-- happen, so `SET sends = ?` is idempotent under redelivery where
-- `sends = sends + ?` would silently double-count and permanently corrupt the
-- verdict. Rates, the leader and the confidence figure are never stored — they
-- are computed from these four integers in app/crm/ab.ts on every render, so a
-- corrected push immediately corrects the verdict.
--
-- `started_at` is absolute like every other timestamp in this schema; the loader
-- converts it to the relative `runningDays` integer the card renders ("running
-- 12d"), which is what keeps SSR and client hydration byte-identical.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 1 = always-on outbound, 2 = event/community blitz. CHECKed because the
  -- domain has exactly two loops and every consumer hardcodes both.
  loop INTEGER NOT NULL DEFAULT 1 CHECK (loop IN (1, 2)),
  -- 'draft' | 'running' | 'concluded'. Whitelisted in app/lib/validate.ts rather
  -- than CHECKed: SQLite cannot drop a CHECK without a full table rebuild, so a
  -- future 'paused' should be a whitelist edit, not a data migration.
  status TEXT NOT NULL DEFAULT 'draft',
  -- Which day of the sequence this template goes out on ("Sent on day 0 …").
  send_day INTEGER NOT NULL DEFAULT 0,
  -- Set when status first leaves 'draft', cleared on a return to 'draft', so it
  -- is non-null exactly when the template has been started. Returning a template
  -- to draft therefore restarts the "running Nd" clock rather than resuming a
  -- stale one — see setTemplateStatus() in app/lib/crm.server.ts.
  started_at TEXT,
  concluded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_variants (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES email_templates(id),
  -- 'A' | 'B'. Whitelisted in app/lib/validate.ts, not CHECKed, for the same
  -- table-rebuild reason as `status` above.
  slot TEXT NOT NULL,
  -- Copy may contain Smartlead merge tokens, in either of its two syntaxes:
  -- {{first_name}} / {{company}} for lead data, and %sender-firstname% /
  -- %signature% for the sending mailbox. (There is no {{sender}}; this comment
  -- used to say there was.) They are stored and rendered as literal text —
  -- nothing in this app interpolates them, and nothing should start.
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  -- The variant "Promote X to default" selected. Exactly one per template; the
  -- invariant is held by promoteVariant()'s two-statement db.batch.
  is_default INTEGER NOT NULL DEFAULT 0,
  -- Pushed counters. Non-negative by constraint: these are the only inputs to
  -- every rate on the page, and a negative one would quietly render a negative
  -- percentage rather than fail loudly.
  --
  -- Deliberately NO cross-field constraint (opens <= sends, replies <= opens).
  -- Pixel-blocking makes `replies > opens` common and real, and partial pushes
  -- arrive out of order, so those inequalities are false in practice.
  sends    INTEGER NOT NULL DEFAULT 0 CHECK (sends    >= 0),
  opens    INTEGER NOT NULL DEFAULT 0 CHECK (opens    >= 0),
  replies  INTEGER NOT NULL DEFAULT 0 CHECK (replies  >= 0),
  meetings INTEGER NOT NULL DEFAULT 0 CHECK (meetings >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Child FK lookup for the grouped read in listTemplates().
CREATE INDEX IF NOT EXISTS idx_template_variants_template
  ON template_variants (template_id);

-- One A and at most one B per template. This is the real guard behind the "add
-- variant B" button: two concurrent clicks (or a double submit) would otherwise
-- create two B rows, and the page would render two cards with the sends split
-- between them. It is also what lets recordVariantStats() resolve a caller's
-- stable "B" to exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_template_variants_slot
  ON template_variants (template_id, slot);
