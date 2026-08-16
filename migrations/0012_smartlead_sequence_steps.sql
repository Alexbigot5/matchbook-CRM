-- The sequence builder's steps: an explicit, ordered campaign sequence per loop.
--
-- Until now the sequence was DERIVED — every non-concluded template on the loop,
-- ordered by send_day, one step each, A/B uploaded as a split. Migration 0009
-- states that choice and its payoff plainly ("derive from the column that is
-- already the source of truth, and there is nothing to keep in sync"), so
-- overriding it needs a reason.
--
-- The reason is that derivation can only express one sequence. It cannot send the
-- same template twice, cannot send variant B on its own, cannot put a nudge
-- before an intro, and cannot set a wait that isn't the arithmetic difference of
-- two send_day values. Every one of those is an ordinary thing to want from a
-- cold-email sequence, and none of them is expressible by editing templates.
--
-- WHAT IS PRESERVED. A loop with NO rows here still derives exactly as before —
-- buildSequencePlan() falls back to the send_day ordering, and the page shows it.
-- Rows appear only when someone first edits the builder, at which point the
-- derived plan is materialised into this table and edited from there ("Reset to
-- template order" deletes them and returns the loop to derivation). So this is
-- an override that has to be opted into, not a replacement, and an account that
-- never opens the builder behaves identically to before.
--
-- WHY THIS IS THE ONE THING WORTH STORING. Step order is not cosmetic: the stats
-- sync maps a Smartlead `sequence_number` back to a template by replaying
-- buildSequencePlan(). If the arrangement that was uploaded lived only in the
-- page's React state, a reload would attribute reply counts to the wrong
-- template — silently, onto absolute counters that feed ab.ts's z-test verdict.
-- Storing the steps is what keeps "what you uploaded" and "what the numbers are
-- attributed to" the same object.
--
-- WHAT IS DELIBERATELY NOT HERE:
--
--   * No copy. A step points at a template; subject and body are read from
--     template_variants at push time. Snapshotting the text here would let the
--     campaign and the Templates page drift apart, and the Templates page is
--     where copy is edited.
--
--   * No seq_number column. `position` is the builder's order; the Smartlead
--     seq_number is 1-based, contiguous, and assigned at build time AFTER steps
--     with no usable copy are skipped. They are different numbers and only one
--     of them is authored, so only that one is stored.
--
--   * No index. The only read is "every step for one loop, in order" over a table
--     holding tens of rows, which SQLite scans faster than it would consult an
--     index. saved_views (0010) says the same thing for the same reason.
--
-- Applied via Wrangler's D1 migrations (tracked in the `d1_migrations` table):
--   npm run db:migrate:local
--   npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS smartlead_sequence_steps (
  id TEXT PRIMARY KEY,
  -- Same two-loop CHECK as smartlead_campaigns and email_templates. Not a
  -- foreign key to smartlead_campaigns: a sequence can be built and reordered
  -- before a campaign is linked, which is the natural order to work in.
  loop INTEGER NOT NULL CHECK (loop IN (1, 2)),
  -- 1-based order within the loop, rewritten wholesale on every reorder. Not
  -- UNIQUE(loop, position): a reorder is a batch of UPDATEs inside one D1
  -- transaction, and swapping two rows transiently collides on any ordering the
  -- statements are issued in. The uniqueness is an invariant of the writers in
  -- app/lib/crm.server.ts, all of which renumber from 1, and a duplicate would
  -- cost a stable tiebreak in the read's ORDER BY — which it has — not a
  -- corrupted sequence.
  position INTEGER NOT NULL,
  -- The template whose copy this step sends. D1 DOES enforce this reference, so
  -- deleting a template that a step points at fails unless the step goes first —
  -- which is why deleteTemplate() drops these rows in the same batch, ahead of
  -- the template itself. No ON DELETE CASCADE: that delete is audited and the
  -- audit is written in that batch too, so the deletion stays one explicit,
  -- ordered transaction rather than half declaration and half code.
  template_id TEXT NOT NULL REFERENCES email_templates(id),
  -- NULL means "every variant with copy", which uploads an A/B template as
  -- Smartlead's own split — the pre-existing behaviour, and what a materialised
  -- step is born with. 'A' or 'B' pins the step to one variant, which is how the
  -- same template can appear twice in a sequence sending different copy.
  -- Whitelisted in app/lib/validate.ts rather than CHECKed, for the reason
  -- 0008 gives: SQLite cannot drop a CHECK without rebuilding the table.
  variant_slot TEXT,
  -- Days to wait BEFORE this step, relative to the previous one — Smartlead's
  -- own `delay_in_days` model, stored in the same terms it is sent in so nothing
  -- has to reinterpret it. The first step's wait is forced to 0 at build time
  -- (Smartlead starts the sequence when the lead enters it, so a delay there
  -- postpones the whole campaign), and the page's cumulative "Day N" is a
  -- running sum computed for display.
  delay_days INTEGER NOT NULL DEFAULT 0 CHECK (delay_days >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
