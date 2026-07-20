CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  loop TEXT DEFAULT 'loop1',
  owner TEXT,
  status TEXT DEFAULT 'new',
  last_touchpoint TEXT,
  community TEXT,
  event TEXT,
  loop1_resumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE touchpoints (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id),
  type TEXT,
  loop TEXT,
  owner TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id),
  body TEXT,
  author TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
