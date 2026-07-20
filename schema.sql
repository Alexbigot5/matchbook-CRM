-- Sales Loop CRM schema. The in-memory Contact/Note model in app/crm/data.ts is
-- the source of truth; columns below mirror it. All timestamps are absolute
-- ISO strings — the loader converts them to the relative `daysAgo`/`followUp`
-- values the UI renders.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  owner TEXT,                      -- 'Tom' | 'Britton' | NULL (unassigned)
  status TEXT NOT NULL DEFAULT 'New',
  loops TEXT NOT NULL DEFAULT '[1]', -- JSON array of loop numbers, e.g. "[1,2]"
  follow_up_at TEXT,               -- absolute ISO date of the next follow-up, or NULL
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  author TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Touchpoints are seeded/read but no UI write path creates them yet. Kept for
-- forward-compat with a future "log touchpoint" feature.
CREATE TABLE IF NOT EXISTS touchpoints (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT,                       -- channel: ad | email | linkedin | call
  loop INTEGER,
  owner TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_contact ON touchpoints(contact_id);
