# CLAUDE.md

Guidance for working in this repo. This is **matchbook-crm** — a "Sales Loop CRM":
a two-loop outbound sales tool (queue, contact list, touchpoint history) built as a
React Router SSR app deployed to Cloudflare Workers.

## Stack

- **React Router v8** (`ssr: true`) — full-stack framework mode, not the library.
- **Cloudflare Workers** runtime (`workers/app.ts` is the entry), with `nodejs_compat`.
- **Cloudflare D1** (SQLite) via the `DB` binding — provisioned but see "Data" below.
- **better-auth** (magic link over email) on D1 — gates the whole CRM. See "Auth" below.
- **Tailwind CSS v4** (via `@tailwindcss/vite`) — only lightly used; the CRM uses inline styles.
- **Vite 8** + **TypeScript** (strict), React 19.

## Commands

```bash
npm run dev              # react-router dev server (local)
npm run start            # wrangler dev — run the built worker locally
npm run build            # react-router build
npm run deploy           # build + wrangler deploy
npm run typecheck        # react-router typegen && tsc  ← run this to verify types
npm run db:migrations:create  # scaffold a new numbered migration in migrations/
npm run db:migrate:local      # apply pending migrations to local D1
npm run db:migrate:remote     # apply pending migrations to remote D1
```

There is **no test runner and no linter** configured. `npm run typecheck` is the only
automated check — run it after changes. Note it runs `react-router typegen` first, which
generates `./+types/*` route type modules that routes import (e.g. `./+types/home`).

## Architecture / request flow

1. `workers/app.ts` — Cloudflare `fetch` handler. Builds a router context per request via
   `createRouterContext(env)` and delegates to React Router's request handler.
2. `load-context.ts` — defines the load context (`{ DB, getAuth, ...integration vars }`). React
   Router v8 uses a `RouterContextProvider`, so **loaders/actions read context with
   `context.get(appContext)`**, not a plain `context.DB`. `appContext` is the exported
   `createContext` handle. It takes the `Request` as well as `env` so the auth base URL can be
   derived per request; `getAuth()` is lazy so non-auth requests don't construct better-auth.
3. `app/routes.ts` — route table: index → `routes/home.tsx`, `/lifecycle`, `/analytics`,
   `/templates`, `/smartlead`, plus `/login`, `/logout`, `/api/auth/*` (better-auth's handler) and
   `/api/hyperagent`.
4. `app/root.tsx` — HTML document shell (`Layout`), root `Outlet`, and `ErrorBoundary`.
5. `app/routes/home.tsx` — the index route's `loader` requires a session then reads contacts
   from D1 (`listContacts`), the `action` re-checks the session and delegates to
   `handleContactIntent` (see below), and the default export renders
   `<SalesLoopCRM contacts={loaderData.contacts} viewer={loaderData.viewer} />`.
5a. `app/routes/lifecycle.tsx` — the `/lifecycle` loader mirrors home's, and its `action` is
   the *same* thin wrapper over `handleContactIntent`. Both routes need one because React
   Router resolves a fetcher's POST against whichever route rendered it, and the contact
   detail slide-over is shared between them.
6. `app/routes/analytics.tsx` — the `/analytics` loader mirrors home's (`requireUser` +
   `listContacts` against one `now`) and additionally returns `buildAnalyticsLabels(now)`, the
   precomputed date axis. **No `action`** — the page is read-only; all writes live on `/`.
7. `app/routes/templates.tsx` — the `/templates` loader reads `listTemplates` **and**
   `listContacts` (the latter only feeds the shared sidebar's OWNER counts) against one `now`.
   It has its own `action` with nine intents. Being a named route, its POSTs need no `?index`.
8. `app/routes/smartlead.tsx` — the `/smartlead` loader reads contacts, templates, the
   campaign bindings and the sequence-builder steps against one `now`, and **makes no
   Smartlead calls**: a loader that reaches a third party makes the page 500 whenever that
   party is down, and every operation here is a manual button anyway. Its `action` has
   fifteen intents (see "Smartlead" below) and is the only session-gated action carrying a
   rate limiter — two of them, in fact: the six sequence-builder intents touch nothing but
   D1 and are metered on their own far looser bucket (`SMARTLEAD_BUILDER_RULE`), listed in
   the `BUILDER_INTENTS` set. Add a builder intent without adding it there and ordinary
   editing burns the push budget.

`app/entry.server.tsx` is the standard streaming SSR entry (`renderToReadableStream`,
5s `streamTimeout`, bot-detection via `isbot`).

## The CRM (`app/crm/`)

Five pages (contacts, lifecycle board, analytics, email templates, Smartlead) over a
shared shell:

- **`data.ts`** — the model and constants. Types (`Contact`, `Touch`, `Note`, `Viewer`), constants
  (`CH` channels, `STATUSES`, `OWNERS`), and pure helpers:
  `needsAttention`, `hasConflict`, `statusMeta`, `loopBadge`, `statusPill`, date formatting
  (`ago`, `fmtDate`, `dateFrom`). The `Contact` shape (with relative `daysAgo`/`followUp`
  integers) is the contract between the server loader and the UI.
  **Determinism matters**: all date math happens server-side in the loader against a single
  `now`; the UI renders only from loader-serialized integers/labels, so SSR and client
  hydration match. Don't introduce `Date.now()`/`Math.random()` into the render path.
- **`ui.tsx`** — presentation primitives. `css(string)` parses an inline CSS **string** into a
  React style object (the app keeps the original template's style strings verbatim). `Box` is
  a polymorphic element (`as=...`, any element type — the sidebar passes `Link`) that adds
  `hover`/`focus` style merging via local state. Plus a set of inline SVG icon components,
  and the shell constants both pages share: `GLOBAL_CSS`, `MONO`, and `crmFontLinks` (the
  Geist webfonts — **every route rendering the CRM shell must re-export it as `links`**, or
  the page silently falls back to the root route's Inter).
- **`sidebar.tsx`** — the shared left rail: the Contacts/Analytics/Lifecycle/Templates nav (a
  **vertical** stack — four items don't fit a segmented control; every item carries
  `border:1px solid transparent` so the active one's real border doesn't shift the others) plus
  the VIEWS and OWNER filter rows, built from `buildViewTabs`/`buildOwnerTabs` (counts are
  always over the **unfiltered** list). `buildViewTabs` takes optional `counts`/`allLabel`
  overrides — `/templates` passes template counts there because its VIEWS rows filter
  templates, not contacts. `Sidebar` also takes an optional `ownerNote`, which only
  `/templates` passes (its OWNER rows are inert; templates have no owner). Purely
  presentational — each page owns its own filter state and click handlers, which is what keeps
  the contacts page's "reset the source filter when leaving Loop 2" rule out of the sidebar.
- **`analytics.ts`** — pure, isomorphic metric aggregation (`computeAnalytics`). No React, no
  server imports, and **no `Date`** — the absolute date labels arrive from the loader. It also
  precomputes colours and bar widths so the page component stays a plain mapper. Note the two
  derived metrics: nothing records a reply or booking as an event, so "replied" and "meetings"
  are read off the contact's *current* pipeline status.
- **`analytics-page.tsx`** — the `/analytics` UI. Read-only (no fetcher, no action). Charts are
  plain divs with percentage widths/heights — there is no charting dependency, deliberately.
- **`templates.ts`** — the email-template model, deliberately separate from `data.ts` (which is
  the *contacts* model). Types (`EmailTemplate`, `TemplateVariant`), the `TEMPLATE_STATUSES` /
  `VARIANT_SLOTS` closed sets, `UNTITLED`, and `templateStatusPill`. Pure, isomorphic, **no
  `Date`**. Note what `EmailTemplate` deliberately does *not* carry: the raw `started_at`
  string. Only `runningDays`/`startedLabel` are exposed, so nothing can be tempted to call
  `Date.now()` in the render path.
- **`ab.ts`** — pure, isomorphic A/B aggregation (`computeTemplatesView`), the same contract as
  `analytics.ts`. Precomputes every rate, bar width, colour and verdict sentence. Two things
  worth knowing: it **resolves the selection** (a `selectedId` missing from the filtered list
  falls back to the first card), which is why the templates page needs no reconciling
  `useEffect` after a delete; and it holds the only statistics in the app — a two-proportion
  z-test on reply rate with a hand-rolled normal CDF. Read the module header before touching
  the verdict: the figure is `1 − p` for "the rates are equal", **not** the probability that
  the leader is better, and it's a fixed-horizon test read continuously.
- **`smartlead-map.ts`** — pure, isomorphic translation to Smartlead's model
  (`buildSequencePlan`, `toHtmlBody`, `planLeads`, `planImport`,
  `totalStatsBySequence`). No React, no server imports, **no `Date`**. Three
  non-obvious rules live here: a step's `delay_in_days` is the wait *relative to the
  previous step*, so `sendDay` 0/3/7 becomes delays 0/3/4; a single-variant step must
  be **flattened** (`subject`/`email_body` on the step) because Smartlead rejects a
  one-entry `seq_variants`; and an **empty plan is blocking**, because
  `POST /sequences` replaces everything and an empty payload erases a live campaign
  rather than doing nothing. `buildSequencePlan` has **two modes over one output**:
  given the loop's stored builder steps it plans exactly those, in that order, with the
  authored waits; given none it *derives* the plan from `send_day` exactly as it always
  did. Both go through the same `assemble()`, which is what stops the two disagreeing
  about what a valid sequence is. `statKey`/`duplicateStatKeys` name the one thing the
  builder can create that the stats sync can't handle — the same (template, variant) in
  two steps — and the sync skips those rather than writing an absolute total twice. `planLeads` excludes contacts already in the *other*
  loop's campaign — `loops` is not exclusive (`resumeToLoop1` keeps Loop 2 while
  adding Loop 1), so without that guard a resumed contact gets two concurrent
  sequences. Variant key names are in the single `SEQ_VARIANT_KEYS` const.
- **`smartlead-page.tsx`** — the `/smartlead` UI, same one-client-component idiom. One
  card per loop: campaign binding, the sequence builder, contact eligibility, schedule,
  stats. The builder (`SequenceBuilder`) is a reorderable step list — native HTML5 drag
  plus ↑/↓ buttons as the **keyboard path**, the same pairing `lifecycle-page.tsx`
  documents — with a per-step variant chip, an editable wait, an expandable copy preview
  and a template picker. Every edit **posts and waits**; there is no local draft of the
  list, because the stored order is what a later stats sync attributes numbers by and a
  list showing an unaccepted arrangement would be lying about where they land. The one
  exception is the wait box's text (a number input can't be typed in if it round-trips
  per keystroke), which posts on blur and is dropped whenever a write settles. Steps are
  addressed by a **token** — the step's id, or `#<position>` for a step the server merely
  derived and which therefore has no row yet.
- **`templates-page.tsx`** — the `/templates` UI, same one-client-component + `useState` God
  object + single `useFetcher` idiom as `sales-loop-crm.tsx`.
- **`lifecycle.ts`** — pure, isomorphic stage model for the board (`LIFECYCLE_STAGES`,
  `stageOf`, `isInStage`, `computeLifecycleBoard`). No React, no server imports, **no
  `Date`**. A lifecycle stage is **derived from `contacts.status`**, not stored: five columns
  over the six statuses (Opportunity holds both `Replied` and `Meeting booked`). There is no
  `lifecycle` column in D1 and deliberately so — `status` stays the single source of truth,
  so a status changed anywhere else moves the card here with nothing to keep in sync. Two
  guards matter: a status claimed by two stages **throws at import**, and a status in
  `STATUSES` that no stage lists is folded into the first stage rather than vanishing from
  the board (the columns must always partition the list, or the header count lies).
- **`lifecycle-page.tsx`** — the `/lifecycle` UI, same one-client-component idiom. Native
  HTML5 drag-and-drop (no library), plus a per-card ⋮ "Move to" menu that is the
  **accessibility fallback** — DnD is pointer-only, so the menu is the only keyboard path to
  a move; don't drop it as redundant. Dropping a card on the column it already occupies is a
  deliberate no-op, which is what stops a `Meeting booked` contact being demoted to `Replied`
  by a nudge inside Opportunity. The board is **one** scroll container with no per-column
  `overflow-y`: a column-level scroll clips every card's ⋮ popover.
- **`contact-detail.tsx`** — the contact detail slide-over, shared by `/` and `/lifecycle`,
  plus the delete-confirm and dead-reason modal **bodies** (the overlay shell stays per-page,
  as it already is between `sales-loop-crm.tsx` and `templates-page.tsx`) and the small bits
  both contact views render (`SourceTag`, `LinkedinButton`, `ownerMeta`, `NO_TOUCH`).
  The panel never deletes or writes `Dead` itself — it raises `onDelete`/`onSetStatus` and
  the page owns those modals. Route `needsDeadReason` through here rather than testing
  `=== "Dead"` inline, or a board drop onto Churned silently skips the reason prompt and
  lands in analytics as "Unspecified" forever. **Dependency direction**: this imports
  `data.ts`/`ui.tsx`/`validate.ts` only — `sales-loop-crm.tsx` imports *it*, never the
  reverse, for the same bundle reason `sidebar.tsx` documents.
- **`sales-loop-crm.tsx`** — the entire UI as **one big client component** taking a
  `contacts` prop from the route loader. A `useState` "God object" (`State`) holds only
  **UI** state (filters, selection, menus, form/CSV drafts) — patched through `patch()`; the
  contact data itself lives in the loader. Every mutation (status changes, notes,
  follow-up snooze/clear, add, CSV import, delete) submits to the route `action` via a single
  `useFetcher` + a hidden `intent` field; React Router revalidates the loader afterward (no
  optimistic UI). Contains all views: sidebar filters, "Needs attention" queue, contact
  table, detail slide-over, add/CSV-import modals.

### Two "loops" domain concept
- **Loop 1** — always-on outbound (grey badge).
- **Loop 2** — event/community blitz (amber badge).
A contact can be in one or both. Owners are **Tom** and **Britton**. A Loop 2 contact carries
a free-text **`source`** (the community/event it came from, e.g. "Newtopia") that the sidebar
can filter by, and can be **resumed into Loop 1** (adds Loop 1, keeps Loop 2, stamps
`resumed_to_loop1_at`). A **cross-owner duplicate** (same name held by both Tom and Britton)
surfaces a red "conflict" flag + detail banner.

## Data persistence

Contacts, notes, follow-ups and email templates **persist to Cloudflare D1**. `app/lib/crm.server.ts` is the
server-only data-access layer (raw D1 prepared statements, `crypto.randomUUID()` ids). It owns
all conversion between stored **absolute** timestamps and the **relative** `daysAgo`/`followUp`
values the UI renders — keeping every `Date` call server-side is what preserves SSR/hydration
determinism. The schema lives in `migrations/` (applied via Wrangler's D1 migrations, tracked
in a `d1_migrations` table) and mirrors the `data.ts` model: `contacts` stores `loops` as a JSON
text array, a nullable `follow_up_at`, a nullable `source`, and a nullable
`resumed_to_loop1_at`; `notes` uses a `text` column. `email_templates` + `template_variants`
(migration `0008`) back the templates page — one row per variant, with a unique
`(template_id, slot)` index that is the real guard behind "add variant B", and CHECKs only on
`loop` and the four `>= 0` counters (`slot`/`status` are whitelisted in `validate.ts` instead,
since SQLite can't drop a CHECK without rebuilding the table). The DB **starts empty** — contacts are
created via the UI / CSV import. **Schema changes:** run `npm run db:migrations:create <name>` to
scaffold a new numbered file in `migrations/`, add your `CREATE`/`ALTER` SQL, then apply it with
`npm run db:migrate:local` / `npm run db:migrate:remote`. Wrangler only runs migrations not yet
recorded in `d1_migrations`, so files are applied once, in numeric order.

**Every contact write lives in `app/lib/contact-intents.server.ts`** — one
`handleContactIntent(form, {DB, user, ...})` switch over the twelve intents (`setStatus`,
`logTouch`, `addNote`, `logMeeting`, `snooze`, `clearFollow`, `addContact`, `resumeLoop1`,
`markAdsSent`, `deleteContacts`, `importContacts`, `triggerAgent`), shared by `/` and
`/lifecycle`. It returns `null` for an unknown intent so each route keeps its own default.
The try/catch is the reason it's one module and not two copies: D1 exception text carries
table and column names and an action's return value is rendered straight into the UI, so it
logs the real cause with a reference id and returns only `Something went wrong. Reference:
<ref>`. `user` is a parameter rather than a `request` — the helper cannot authenticate, so
it can't be reached without the caller running `requireUser` first. **Add new contact write
paths here, not inline in a route.**

**Input validation lives in `app/lib/validate.ts`** — shared by the session action
(`home.tsx`) and the machine API (`api.hyperagent.ts`), which previously disagreed about what
was acceptable. It owns the field length limits (`LIMITS`), the import/bulk-id caps, the
`status`/`owner`/`loop`/touch-type/template-status/variant-slot whitelists, the email format
check, the template validators (`validateTemplate`, `validateVariantContent`, `validateStats`,
`validateVariantTarget` — the last two shared verbatim by `templates.tsx` and the machine API),
and two output
escapers: `csvCell` (RFC 4180 quoting **plus** neutralizing a leading `= + - @ \t \r`, which
Excel and Sheets execute as a formula) and `safeMailto` (returns null unless the address is
plain, so a stored `…?bcc=…&body=…` can't prefill an attacker's draft). It is isomorphic —
the client imports `LIMITS` for `maxLength` and the CSV caps. **Add new write paths through
this module rather than validating inline.**

Deletion is recorded in an append-only `audit_log` table with a JSON snapshot of each removed
row and the acting user — contact deletion is a hard delete that also drops the contact's
notes and touchpoints, on a dataset shared by all four users. Template and variant deletion
audit too (`template.delete` / `template_variant.delete`); the template snapshot carries its
variants as well, since the copy is the only irreplaceable thing on that page. Stat writes are
**not** audited — they're non-destructive and re-pushable, and logging every poll would flood
the table.

## Smartlead

The actual sending tool. `/smartlead` binds **one Smartlead campaign per loop** and drives
five things: building the sequence out of templates from the Templates page, pushing
contacts in as leads, uploading that sequence as the campaign's steps, setting the sending
schedule, and a manual stats sync back onto the template variant counters. There is
deliberately **no cron and no inbound webhook** — every operation is a button. The builder
is the only one of the five that never leaves D1.

- **`app/lib/smartlead.server.ts`** — the HTTP client, shaped like `hyperagent.server.ts`
  (never throws, returns a result, empty key = disabled). Two things to keep: **the API
  key is a query parameter**, not a bearer header, so it is inside every request URL —
  everything returned or logged goes through `redact()`, and `console.error(res.url)`
  would leak a live secret. And it **does not retry**: a 429 is reported with its
  Retry-After, because every operation is resumable by pressing the button again (the
  unique index on `smartlead_leads` is what makes a re-press safe), and retrying is what
  you do when re-running isn't. `toStatusInput()` exists because Smartlead *reports*
  `ACTIVE` but only *accepts* `START` — posting a read value straight back is a 400.
- **`migrations/0009_smartlead.sql`** — `smartlead_campaigns` (keyed on `loop`, so
  one-campaign-per-loop is a schema fact) and `smartlead_leads` (the contact↔campaign
  link, with a unique `(contact_id, campaign_id)` index as the real double-push guard).
  There is still no template→`seq_number` table: the Smartlead numbering is *derived* by
  `buildSequencePlan`, and the stats sync replays the same function to map a
  `sequence_number` back to a template. `deleteContacts` drops the lead links too.
- **`migrations/0012_smartlead_sequence_steps.sql`** — the sequence builder's authored
  steps (`loop`, `position`, `template_id`, `variant_slot`, `delay_days`). This is the one
  override of 0009's "derive, don't store" rule, and it is narrow: **no rows for a loop
  means derive**, so a loop nobody has edited still tracks its templates and gains a step
  when one is added. The rows are written on the *first edit*
  (`materializeSequenceSteps`), and "Reset to template order" deletes them. What is
  stored is only the authored order — never the seq_number derived from it — and never
  the copy, which stays in `template_variants` so the campaign can't drift from the
  Templates page. Two consequences worth knowing: **removing the last step is refused**
  (an empty table means "derive", so it would restore every template rather than nothing),
  and `deleteTemplate` must drop a template's steps *before* the template, since D1 does
  enforce that foreign key.
- **Sync timestamps are written as ISO strings from JS**, not via `datetime('now')`. The
  loader `Date.parse`es them to build a label, and SQLite's default has no timezone
  designator, so the column default would read a UTC instant as local time. `created_at`
  keeps the default because it is only ordered on, never parsed.
- **`pushSequence` pauses the campaign and leaves it paused.** Smartlead refuses sequence
  edits on an ACTIVE campaign with an opaque 400, so the pause is required; not
  auto-resuming is a choice — silently restarting sends right after the copy changed
  isn't a button's decision, and it removes the failure mode where a failed auto-restore
  leaves a live campaign paused with no signal.
- **A single Smartlead step can't be split per variant.** The `/statistics` rows carry a
  `sequence_number` but no variant id, so a step uploaded as an A/B split is skipped by
  name. A step the builder has **pinned** to a slot is one variant by construction, so its
  numbers land on that slot — which is how a pinned B gets real figures rather than
  hand-typed ones. The other side of that: the same (template, slot) in two steps is
  skipped too, since these are absolute totals and the second write would replace the
  first. `meetings` is always passed as `null` — Smartlead
  has no meeting concept, and `validateStats`' null-means-leave-alone is what preserves a
  hand-entered figure. If the campaign has more rows than the page budget the sync writes
  **nothing**: these are absolute totals, so a partial aggregate reads as a collapse in
  performance rather than as missing data.
- **Nothing was added to `/api/hyperagent`.** The same rule that keeps template copy off
  that bearer token applies harder to a token that could re-point or start a campaign.

Security headers (CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS on https, etc.) are set in
`workers/app.ts`, wrapping every dynamic response. They do **not** apply under
`npm run dev` (the Vite dev server doesn't route through the Worker entry) — use
`npm run start` to see them.

Gotchas:
- **Touchpoints are written by three paths**: the `logTouch` intent (the detail panel's "Log
  touch" channel chips), `logMeeting`, and the bulk `markAdsSent`. They only reflect activity
  logged in-app — nothing backfills historical outreach, so the analytics channel and activity
  panels start sparse. The touch-based `hasConflict`/`peopleInvolved` still rarely fire; the
  live conflict flag remains the name-based `hasNameConflict`/`conflictOwners`.
- **`contacts.dead_reason`** is captured by a prompt that intercepts the shared `setStatus`
  handler whenever a contact is set to Dead (covering both the row and detail status menus).
  `updateContactStatus` writes the column on *every* status change, so moving a contact off
  Dead clears it. Contacts marked Dead before migration `0007`, and anyone who skips the
  prompt, are reported as "Unspecified".
- Index-route **actions require `?index`** in the POST URL (the client's `useFetcher` adds it
  automatically; a raw `curl` to `/` hits the layout route and 405s). `/templates` and
  `/lifecycle` are named routes, so their POSTs don't need it.
- **Template metrics are pushed, never derived.** Nothing in this app sends email or tracks
  opens, so `template_variants.sends/opens/replies/meetings` are counters written by an external
  sending tool via `POST /api/hyperagent {op:"recordTemplateStats"}` (or typed into the page's
  "Record numbers" modal). They are **absolute lifetime totals, not increments** — the caller
  has no idempotency key and Workers redelivery happens, so `SET sends = ?` is safely repeatable
  where `sends = sends + ?` would double-count and permanently corrupt the verdict. An omitted
  field COALESCEs to the stored value, which is why `validateStats` distinguishes absent from
  zero. Every rate and the whole A/B verdict is **computed** in `ab.ts` from those four
  integers, so a corrected push immediately corrects the verdict. The page therefore starts at
  "No sends yet" on a fresh DB, and the `/templates` GET resource (`?resource=templates`)
  exposes `isDefault` so "Promote to default" actually reaches the sender.
- **Every `template_variants` write is constrained by `AND template_id = ?`**, not just the
  variant's own id — otherwise a caller could pass another template's variant id and, through
  `promoteVariant`, clear template X's default while setting Y's. `promoteVariant`'s clear is
  additionally guarded by an `EXISTS` on the target: `db.batch` atomicity covers failure, not a
  statement that legitimately matches zero rows, so without the guard a cross-template id
  committed a template with **no** default at all.
- **The machine API can move template counters but not template copy.** No
  `createTemplate`/`saveVariant`/`deleteTemplate` op exists on `/api/hyperagent`, deliberately:
  a bearer token that can rewrite outbound email copy is a phishing primitive.

## Auth

Magic-link sign-in via better-auth, with email delivered by **Resend**. The dataset is shared,
but access is restricted to four hardcoded addresses.

- **`app/lib/allowlist.ts`** — the four permitted emails mapped to display names. Isomorphic
  (no secrets). Editing this is how you add or remove a user; a removal takes effect on that
  person's next request even if they hold a live session cookie.
- **`app/lib/auth.server.ts`** — `createAuth(env, baseURL)`. Passes the raw `DB` binding as
  `database` (better-auth duck-types it and loads its own bundled D1 dialect — `kysely-d1` is
  **not** used). `emailAndPassword` is off deliberately: mounting the handler would otherwise
  publish a public `/api/auth/sign-up/email`. `session.cookieCache` is off so a revoked user
  can't stay live for 5 minutes.
- **The allowlist is enforced at five layers** — the `/login` action, better-auth's
  `hooks.before` (covers direct POSTs to the public sign-in endpoint), the
  `databaseHooks.user.create.before` hook, `requireUser()` on every loader/action, and a
  re-check in `app/routes/api.auth.$.ts` before proxying to better-auth's own handler (that
  route bypasses `requireUser`, so a de-allowlisted user with a live cookie could otherwise
  still reach `get-session`/`update-user`). Keep all five when touching this; layer 2 is what
  guarantees no email is ever sent to a stranger. `isAllowed` uses `Object.hasOwn`, not `in`
  — `in` walks the prototype chain, so `"constructor"` and `"__proto__"` passed.
- **`createAuth` throws when `BETTER_AUTH_SECRET` is unset.** Don't remove that assertion:
  better-auth only throws on its own when it *also* believes it's in production
  (`secret === DEFAULT_SECRET && !isProduction`, keyed on `NODE_ENV`). If `NODE_ENV` isn't
  `"production"` in the deployed isolate it silently falls back to a published default secret,
  which means forgeable session cookies.
- **Rate limiting** — `app/lib/ratelimit.server.ts`, backed by a D1 `rate_limits` table.
  Durable because a module-level `Map` is per-isolate on Workers and evicted constantly (which
  is also why better-auth's limiter is configured with `storage: "database"`). Metered:
  `POST /login` (per IP *and* per target address — that action calls `auth.api.*` directly and
  so bypasses better-auth's own limiter) and `/api/hyperagent` (per IP, plus a tighter bucket
  for failed bearer-token attempts). The limiter **fails open** on a D1 error — it is an
  availability control, not the authorization gate.
- **`POST /login` passes `request`**, not just `headers`. better-auth's origin check and CSRF
  middleware both short-circuit on `if (!ctx.request) return`, so omitting it disables them.
- **`app/lib/session.server.ts`** — `requireUser()` / `getOptionalUser()`. Gating is
  **per-route, not in `root.tsx`**: every route is a child of root, so a root loader would also
  gate `/login` and `/api/auth/*`. Actions must call `requireUser` independently of loaders.
- **`/api/hyperagent` is deliberately not session-gated** — it authenticates with the
  `CRM_API_KEY` bearer token for machine callers.
- **Secrets**: `BETTER_AUTH_SECRET` (required — better-auth *throws* on every request in a
  production build if unset), `RESEND_API_KEY` and `SMARTLEAD_API_KEY` (optional — empty
  disables `/smartlead`; never a `[vars]` entry, since it travels in request URLs).
  `AUTH_EMAIL_FROM` is a `[vars]` entry; its domain must be verified in Resend or nothing
  sends.
- **`migrations/0004_auth_tables.sql` is generated, not hand-written** — produced by
  better-auth's own `getMigrations()` for the installed version. Regenerate it if better-auth
  is upgraded or a plugin with its own schema is added; don't hand-edit the columns.
- The note/touchpoint author is the signed-in user's display name, threaded from the loader as
  the `viewer` prop. `OWNERS` in `data.ts` needs an entry for anyone who can sign in, or their
  avatar lookup falls back to a grey placeholder.

## Conventions

- **Inline-style strings** passed through `css("...")`, not Tailwind classes, throughout the
  CRM. Match that style when editing CRM components. Tailwind is only meaningful in
  `app/root.tsx` / `app/welcome/`.
- **`~/*` path alias** → `app/*` (see `tsconfig.json`).
- Use `Box` for anything needing hover/focus styling; raw elements otherwise.
- Route modules import generated types from `./+types/<route>` — run typegen before tsc.

## Files that are NOT the app (ignore unless relevant)

- `app/welcome/` — leftover React Router starter scaffold. Not referenced by `routes.ts`.
- `crm-app/` — gitignored leftover from an earlier migration.

## Deployment

Cloudflare Workers via Wrangler (`wrangler.toml`): worker name `matchbook-crm`, D1 database
`crm-db` bound as `DB`, static assets served from `./build/client`. `Env` (the worker
bindings type) is generated by Wrangler into `worker-configuration.d.ts` (gitignored).
