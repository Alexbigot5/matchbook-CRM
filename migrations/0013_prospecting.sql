-- The prospecting agent: find people with an Origami agent run, stage the
-- results, promote the approved ones into `contacts`.
--
-- Until now the CRM only ever RECEIVED contacts — typed into the Add form or
-- pasted in via CSV import. Both loops assume a steady supply of new names at
-- the top and nothing in the app produced one. These two tables are the staging
-- area between "an agent found forty people" and "four of them are contacts".
--
-- WHY RESULTS ARE STAGED RATHER THAN INSERTED. The contacts table is shared by
-- all four users and a contact is the unit the whole app is built on. An agent
-- that wrote to it directly would put unreviewed, machine-guessed rows in front
-- of everyone, and the only undo is a hard delete. So a run's output lands here,
-- a human ticks the rows they want, and promotion goes through the SAME
-- validateImportRows + createManyContacts path a CSV import uses.
--
-- THE PROVIDER'S SHAPE, AND WHY IT LEAKS INTO THIS SCHEMA. Origami runs are
-- asynchronous: POST /agents returns a `running` run and you poll
-- GET /agents/{id}/runs/{runId} until `status` is terminal, honouring the
-- Retry-After header (15s). Runs take 1-5 minutes. A Cloudflare Worker cannot
-- sit and wait for that, and this app has no Durable Object, no queue and no
-- cron — D1 is the only store. So the run is driven forward one step per client
-- poll, and every field needed to resume it lives in a row here. That is what
-- `stage`, `next_poll_at`, `agent_id` and `provider_run_id` are for: any request
-- can pick a run up mid-flight, including after a page refresh.
--
-- A THREAD IS AN AGENT. An Origami agent keeps its workspace and conversation
-- across runs and does one run at a time, so the conversation in the panel is
-- every prospect_runs row sharing an `agent_id`, ordered by created_at. That is
-- also how a run that ends `needs_input` gets answered: a follow-up run on the
-- same agent, linked back through `previous_run_id`.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * No index. A team's runs are tens of rows and a run's prospects are
--     hundreds at most; SQLite scans them faster than it consults an index.
--     saved_views (0010) and smartlead_sequence_steps (0012) say the same.
--
--   * No CHECK on `status`, `stage`, `email_confidence` or `dedupe`. These are
--     closed string sets and 0008's rule applies — SQLite cannot drop a CHECK
--     without rebuilding the table, so closed string sets are whitelisted in
--     app/lib/validate.ts instead. `status` earns it twice over: it holds
--     Origami's eight run states, the v2 API is documented as beta, and a CHECK
--     would turn a newly-added provider status into a 500 on an existing run.
--
--   * No copy of the Origami table's rows beyond the seven fields we map.
--     The agent's table is the system of record for its own research; this
--     stores what a contact needs and the source URL to get back to the rest.
--
--   * No unique index on (run_id, email). Deduping is against `contacts`, not
--     within a run, and a run that legitimately returns two people at the same
--     shared inbox should show both rather than silently drop one.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS prospect_runs (
  id TEXT PRIMARY KEY,
  -- The Origami agent this run belongs to. NOT unique: every follow-up run
  -- reuses it, and grouping by it is what reconstitutes the conversation.
  -- Nullable because the row is written BEFORE the provider call, so a run whose
  -- POST /agents never returned still has a row explaining why.
  agent_id TEXT,
  -- Origami's own run id, the second half of the polling address.
  provider_run_id TEXT,
  -- The run this one answers or continues, for a follow-up. Self-referencing so
  -- the panel can order a thread even if two runs share a created_at second.
  previous_run_id TEXT REFERENCES prospect_runs(id),
  -- What the user typed. Stored raw, NOT the composed brief that is actually
  -- sent: the composed version is derived (composeBrief in app/crm/prospecting.ts)
  -- and re-deriving it keeps the column honest about what the human asked for.
  prompt TEXT NOT NULL,
  -- Origami's run status, verbatim: running, completed, needs_input, incomplete,
  -- step_cap_hit, cancelled, errored, timed_out. Whitelisted in validate.ts —
  -- see the header for why this is not a CHECK.
  status TEXT NOT NULL,
  -- OUR pipeline phase, which is not the same thing: starting, researching,
  -- reading, ready, failed. Origami reports no mid-run progress, so `status`
  -- only ever moves once; `stage` is what tells the next poll whether the work
  -- left to do is "ask the provider again" or "read the table it built".
  stage TEXT NOT NULL,
  -- Earliest moment the next poll may spend an Origami call, as an ISO string.
  -- The client polls this app every few seconds to keep its elapsed timer alive;
  -- this is what stops that becoming a call to Origami every few seconds. Their
  -- limit is 100 requests/minute PER ORGANIZATION, shared by every key.
  --
  -- Written from JS as an ISO string, never datetime('now'): it is Date.parse()d
  -- on every poll and SQLite's default emits no timezone designator, so the
  -- default would read a UTC instant as local time. Same trap 0009 and 0010 flag.
  next_poll_at TEXT,
  -- response.text — the agent's prose summary. NULL while running, and also on
  -- errored and timed_out runs, where Origami documents it as null.
  summary TEXT,
  -- response.actions[] as JSON: the structured record of what the agent did
  -- (table_created, leads_added, ...). Read back whole to build the checklist,
  -- never queried across rows — the same justification 0010 gives `conditions`.
  actions TEXT,
  -- The first entry of todo.pendingQuestions[] when the run ended needs_input.
  -- Only the first: the panel asks one thing at a time, and answering it starts
  -- a follow-up run that will re-ask anything still outstanding.
  question TEXT,
  -- The Origami table the run built, from response.tables[]. The address for the
  -- `reading` stage, and NULL for a run that built nothing.
  table_id TEXT,
  -- JSON tallies for the checklist: how many rows the table held, how many we
  -- read, how many were skipped as invalid, how many deduped and why. Derived
  -- once at ingest so the panel stays a plain mapper.
  counts TEXT,
  -- Why the run failed, already redacted and made human-readable by the route.
  error TEXT,
  -- The creator's normalized email — the visibility key, exactly as saved_views
  -- (0010) uses it. Never sent to the client.
  created_by TEXT NOT NULL,
  -- Display name, cached for the caption. Never used to address anything.
  created_by_name TEXT NOT NULL,
  -- Ordered on, never parsed. That is what makes the datetime('now') default
  -- safe here where it would not be on next_poll_at or updated_at.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Last time the row moved, as an ISO string from JS. Date.parse()d to build
  -- the "ran 3m ago" label, so it must not use the datetime('now') default.
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  -- D1 does enforce this reference. deleteProspectRun therefore drops these rows
  -- first, in the same batch — no ON DELETE CASCADE, so the deletion stays one
  -- explicit ordered transaction rather than half declaration and half code.
  -- 0012 makes the same call for smartlead_sequence_steps.
  run_id TEXT NOT NULL REFERENCES prospect_runs(id),
  -- Insertion order from the Origami table, preserved so the list the user
  -- reviews matches the order the agent ranked them in.
  position INTEGER NOT NULL,
  -- The five fields a contact needs, plus the three that only help a human
  -- decide. Only `name` is required — validateContact rejects a nameless row,
  -- so anything stored here can at least be promoted.
  name TEXT NOT NULL,
  company TEXT,
  title TEXT,
  email TEXT,
  linkedin TEXT,
  location TEXT,
  -- Where the agent found them. Rendered as a link so a human can check the
  -- claim before adding the person; this is the only route back to the evidence.
  source_url TEXT,
  -- verified | likely | none. DERIVED, not reported: the Origami v2 API exposes
  -- no confidence field, so this reads an email-status or score column when the
  -- agent produced one and otherwise falls back to "does it parse". The UI is
  -- explicit that the fallback is an inference — see emailConfidence() in
  -- app/crm/prospecting.ts.
  email_confidence TEXT,
  -- NULL when this person is new. "email" or "name" when they already exist in
  -- contacts, naming which test matched.
  --
  -- Deduped rows are STORED AND HIDDEN rather than dropped. That is what makes
  -- "7 already in the CRM, removed" a real number instead of a guess, and it
  -- survives re-opening the run days later.
  dedupe TEXT,
  -- The contact they matched. Deliberately NOT a foreign key: the contact may be
  -- hard-deleted later (contact deletion is a real DELETE, audited in
  -- audit_log), and that must not fail or cascade into a historical run.
  existing_contact_id TEXT,
  -- Set when this prospect was promoted into contacts, which is also what makes
  -- a second click on "Add" a no-op instead of a duplicate.
  promoted_contact_id TEXT
);
