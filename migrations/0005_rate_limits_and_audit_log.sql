-- Security hardening: durable rate limiting and a delete audit trail.
--
-- Both tables exist because Workers gives us no usable per-process state. The
-- obvious in-memory Map (which is what better-auth's default rate limiter uses)
-- is per-isolate and evicted constantly, so it does not actually limit anything
-- in production. D1 is the only shared store this app has.

-- Fixed-window counters keyed by "<bucket>:<subject>" — see app/lib/ratelimit.server.ts.
-- `window_start` is the epoch-ms start of the window the count belongs to; a row
-- whose window_start is stale is reset rather than incremented, so a key needs
-- only one row for all time.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Lets the opportunistic prune (run only when a new window opens) find expired
-- rows without a full scan.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

-- Append-only record of destructive actions. Contact deletion is a hard delete
-- that also removes the contact's notes and touchpoints, and the dataset is
-- shared across all four users, so without this there is no way to tell what was
-- removed or by whom. `snapshot` holds the deleted row as JSON so a mistaken
-- bulk delete can be reconstructed.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT,                      -- display name from the session, or a machine identity
  action TEXT NOT NULL,            -- e.g. 'contact.delete'
  entity_type TEXT NOT NULL,       -- e.g. 'contact'
  entity_id TEXT,
  snapshot TEXT,                   -- JSON of the row as it existed, or NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
