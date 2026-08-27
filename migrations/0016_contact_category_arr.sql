-- Brand facts backfilled onto contacts from scripts/brand-directory.csv.
--
--   category — the brand's product vertical ("Food & Beverage", "Beauty").
--   arr      — what the directory says about the brand's revenue.
--
-- Both are free text, and deliberately so. The directory holds ~36 raw category
-- strings that are really ~10 categories spelled inconsistently ("Food & Bev",
-- "Food/Bev", "food/bev"), and normalizing them is a judgement call about the
-- taxonomy, not a schema concern — so no CHECK and no closed set here.
--
-- `arr` is TEXT rather than a number because the source is not uniformly a
-- figure. Roughly 60% of rows are ("$12 million", "$5M - $20M"); the rest are an
-- enrichment model's prose about why it could not pin one down ("Revenue is
-- estimated based on secondary sources…", up to 684 characters). Storing the
-- raw string keeps both kinds intact; app/crm/data.ts is where the two are told
-- apart for display. A REAL column would have had to discard the second kind.
--
-- Nullable with no default: matching is by brand name against the contact's
-- company, and roughly a third of the contact book is influencer handles and
-- test rows that no directory entry describes. NULL there is the honest answer,
-- not a missing value to be filled in later.
--
-- Schema only, as every migration in this repo is. The data sweep that fills
-- these in is scripts/backfill-contact-tags.sql, applied by hand.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so this must run exactly once per
-- database — which Wrangler guarantees via the `d1_migrations` table.

ALTER TABLE contacts ADD COLUMN category TEXT;
ALTER TABLE contacts ADD COLUMN arr TEXT;
