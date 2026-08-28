-- Backfill: give every contact that already names a company a row in
-- `companies`, and point contacts.company_id at it.
--
-- Unlike scripts/backfill-contact-tags.sql (0016's data sweep, applied by hand
-- from an external CSV) this one derives everything from data already in the
-- database, so it belongs in the migration sequence: the `companies` table is
-- empty and useless until it runs, and every deal created afterwards depends on
-- it. Nothing here reads a file and nothing here is a judgement call.
--
-- REPRODUCING normalizeName() IN SQL. app/crm/data.ts defines the identity of a
-- name as `trim().toLowerCase().replace(/\s+/g, " ")`, and app/lib/crm.server.ts
-- will apply exactly that in findOrCreateCompanyByName for every company created
-- from here on. If this migration normalized even slightly differently, the
-- first contact imported after it would fail to match the company its
-- colleagues are already attached to and would silently mint a duplicate — the
-- precise failure the `companies` table exists to prevent. So the three steps
-- are reproduced literally:
--
--   1. \s+ covers tab, newline and carriage return, not just the space
--      character, so those are folded to spaces first.
--   2. Runs of spaces are collapsed with the sentinel idiom: expand every space
--      to <char(1)char(2)>, delete every <char(2)char(1)> that an adjacent pair
--      produced, then contract what is left back to one space. This collapses a
--      run of ANY length, which a fixed chain of replace('  ',' ') does not.
--      char(1)/char(2) rather than printable sentinels because a company name
--      containing the sentinel would otherwise be corrupted, and no company name
--      contains a control character.
--   3. trim, then lower.
--
-- The view exists only to state that expression once instead of three times;
-- it is dropped at the end of this migration.
CREATE VIEW _contact_company_norm AS
SELECT
  id AS contact_id,
  -- Display form: whitespace tidied, capitalization left exactly as typed.
  trim(
    replace(
      replace(
        replace(
          replace(replace(replace(company, char(9), ' '), char(10), ' '), char(13), ' '),
          ' ', char(1) || char(2)
        ),
        char(2) || char(1), ''
      ),
      char(1) || char(2), ' '
    )
  ) AS display,
  -- Identity form: the same string, lowercased.
  lower(trim(
    replace(
      replace(
        replace(
          replace(replace(replace(company, char(9), ' '), char(10), ' '), char(13), ' '),
          ' ', char(1) || char(2)
        ),
        char(2) || char(1), ''
      ),
      char(1) || char(2), ' '
    )
  )) AS norm
FROM contacts
-- A blank or whitespace-only company is not a company. Those contacts keep
-- company_id NULL and go on rendering exactly as they do today.
WHERE trim(coalesce(company, '')) <> '';

-- One row per distinct normalized name.
--
-- `name` is the MOST COMMON spelling rather than an arbitrary one: with 14
-- contacts spelling it "Halcyon Labs" and one "halcyon labs", the header of
-- every company view should read the way the book overwhelmingly reads. Ties
-- break alphabetically so the result does not depend on row order.
--
-- The id is a v4 UUID built from randomblob, matching the crypto.randomUUID()
-- shape every other id in this database has — a backfilled company must not be
-- distinguishable from one created later by findOrCreateCompanyByName.
INSERT INTO companies (id, name, normalized_name)
SELECT
  lower(
    substr(hex(randomblob(4)), 1, 8) || '-' ||
    substr(hex(randomblob(2)), 1, 4) || '-4' ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    hex(randomblob(6))
  ),
  display,
  norm
FROM (
  SELECT
    norm,
    display,
    ROW_NUMBER() OVER (PARTITION BY norm ORDER BY COUNT(*) DESC, display ASC) AS rn
  FROM _contact_company_norm
  GROUP BY norm, display
)
WHERE rn = 1;

-- Point each contact at its company. `company` itself is left untouched — it
-- stays the display/legacy column, and the brand-directory match from 0016 is
-- still keyed on it.
UPDATE contacts
SET company_id = (
  SELECT c.id
  FROM companies c
  JOIN _contact_company_norm n ON n.norm = c.normalized_name
  WHERE n.contact_id = contacts.id
)
WHERE company_id IS NULL
  AND trim(coalesce(company, '')) <> '';

DROP VIEW _contact_company_norm;
