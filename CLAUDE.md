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
   `/templates`, `/smartlead`, `/settings`, plus `/login`, `/logout`, `/api/auth/*`
   (better-auth's handler) and `/api/hyperagent`.
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
   `listContacts` against one `now`), additionally returns `buildAnalyticsLabels(now)` (the
   precomputed date axis) and, for the **Email campaigns** tab, one `CampaignLoopInput` per
   loop: the campaign binding, the pushed-lead count, the sequence resolved through the
   *same* `buildSequencePlan` /smartlead uploads with, and `readCampaignEventStats` for each
   **bound** loop (a second round trip, because it needs the bindings from the first; an
   unbound loop is skipped rather than scanned for a guaranteed empty answer). Like
   /smartlead's, this loader **makes no Smartlead calls** — it reads D1 only, so a vendor
   outage doesn't 500 the page. **No `action`** — the page is read-only; all writes live
   on `/`.
7. `app/routes/templates.tsx` — the `/templates` loader reads `listTemplates` **and**
   `listContacts` (the latter only feeds the shared sidebar's OWNER counts) against one `now`.
   It has its own `action` with nine intents. Being a named route, its POSTs need no `?index`.
8. `app/routes/smartlead.tsx` — the `/smartlead` loader reads contacts, templates, the
   campaign bindings and the sequence-builder steps against one `now`, and **makes no
   Smartlead calls**: a loader that reaches a third party makes the page 500 whenever that
   party is down, and every operation here is a manual button anyway. Its `action` has
   twenty intents (see "Smartlead" below) and is the only session-gated action carrying a
   rate limiter — two of them, in fact: the seven builder/copy-editor intents touch nothing
   but D1 and are metered on their own far looser bucket (`SMARTLEAD_BUILDER_RULE`), listed in
   the `BUILDER_INTENTS` set. Add a builder intent without adding it there and ordinary
   editing burns the push budget.

9. `app/routes/settings.tsx` — the `/settings` loader reads contacts (sidebar counts only),
   the stored Unipile sync state and the unread-reply count, and — like `/smartlead`'s —
   **makes no Unipile calls**. Its `action` has six intents: `signOutEverywhere`,
   `fetchAccounts`, `connect`, `disconnect`, `resetWatermark` and `syncReplies`, and it
   layers the two shared reply intents from `contact-intents.server.ts` around them the same
   way `/` layers its saved-view intents. Two rate-limit buckets again, and note which side
   `signOutEverywhere` is on: it is metered as a *light* intent so ten impatient presses of
   Sync cannot lock someone out of the control they reach for when a laptop goes missing.

`app/entry.server.tsx` is the standard streaming SSR entry (`renderToReadableStream`,
5s `streamTimeout`, bot-detection via `isbot`).

## The CRM (`app/crm/`)

Six pages (contacts, lifecycle board, analytics, email templates, Smartlead, settings)
over a shared shell:

- **`data.ts`** — the model and constants. Types (`Contact`, `Touch`, `Note`, `Viewer`), constants
  (`CH` channels, `STATUSES`, `OWNERS`), and pure helpers:
  `hasConflict`, `statusMeta`, `loopBadge`, `statusPill`, date formatting
  (`ago`, `fmtDate`, `dateFrom`). The `Contact` shape (with relative `daysAgo`/`followUp`
  integers) is the contract between the server loader and the UI.
  **Determinism matters**: all date math happens server-side in the loader against a single
  `now`; the UI renders only from loader-serialized integers/labels, so SSR and client
  hydration match. Don't introduce `Date.now()`/`Math.random()` into the render path.
- **`todo.ts`** — the contacts page's **To do** list, and what replaced `needsAttention`.
  Pure, isomorphic, **no `Date`** — same contract as `analytics.ts` and `views.ts`.
  `nextTodo(contact)` returns **one** item or null: reply / opened / call / linkedin /
  sequence / assign / add, in that priority order, which is also the order the page renders
  the groups in. One per contact is what keeps the list a work queue rather than a set of overlapping
  tags, and it is what makes the `todo` saved-view field answerable.
  **The channel ladder is the email sequence → LinkedIn → the phone**, and the two middle
  rules are mutually exclusive by construction: LinkedIn is suggested only when it has
  never been tried, the phone only once it has and went unanswered *as well as* the
  sequence (`EMAILS_BEFORE_LINKEDIN` = 2 unanswered emails — one email is the first step of
  a sequence, not a sequence). The call rule additionally requires `allQuiet`, i.e. every
  channel silent for `SILENT_DAYS`, so it never fires over a message sent three days ago.
  **The `opened` rule is the one that reasons from something other than silence.** Every
  other rule here infers from the timeline going quiet, because with touchpoints alone that
  is the only evidence there is. `openedStep` / `campaignReplied` on the `Contact` (read off
  `smartlead_email_events` by `listContacts`, matched on lowercased email — see "Smartlead"
  below) say the person opened step `OPENED_STEP_FOR_LINKEDIN` (2, matching
  `EMAILS_BEFORE_LINKEDIN` and for the same reason) or later and still has not written back,
  which is better evidence and evidence of the opposite thing — so it fires the day the open
  syncs rather than waiting out `SILENT_DAYS`, and it sits above the ladder. Three guards, all
  load-bearing: `campaignReplied` (Smartlead's own record that the address answered, a
  *different witness* from `status === "Replied"`, which only exists where Unipile is
  connected and synced), `status !== "Meeting booked"` (this rule has no silence requirement,
  so without it every opener with a call already booked gets a DM instruction), and a
  LinkedIn URL on file. That last one, plus contacts the CRM does not hold at all, is why the
  group is smaller than the open count on /analytics' campaign tab — the two figures are
  answering different questions and are not meant to match. Missing engagement is **unknown,
  never zero**: a contact no campaign has emailed has `openedStep` null.
  **Every count and every silence figure the ladder uses is OUTBOUND ONLY**, via `isInbound`
  — the `REPLY_NOTE_PREFIX` on the touchpoint note, imported from `campaigns.ts` because a
  touchpoint has no direction and no source column. An out-of-office autoresponder is filed
  by the Unipile sync as an ordinary `email` touchpoint, so counting the timeline naively
  made one real send plus one autoresponder trip the two-email threshold after a single
  step, *and* reset the silence clock so the call rule was held off for five days. Note this
  is **not** an out-of-office rule — a genuine reply is not an email we sent either, nor is
  a bounce. Nothing here recognises message text, deliberately: "what did we send" is exact,
  "is this an autoresponder" is a heuristic that gets someone's real "I'm out next week,
  call me Thursday" wrong, and losing a real reply is the one failure this list must not
  have.
  **The two counts are not symmetric**: email touches are backfilled by the Smartlead sync,
  LinkedIn touches exist only because a rep pressed "Log touch". So logging the LinkedIn
  touch is what clears the LinkedIn row and makes the contact eligible for the call rule —
  and a message sent but never logged keeps the contact in the LinkedIn group, which is the
  deliberate failure direction.
  Three more things to know before editing a rule. **Touchpoints have no direction column**, so nothing here may try
  to tell our email from theirs — `status === "Replied"` (written by the Unipile sync) is
  the only record that somebody answered. And **`followUp >= 0` means due**: it is
  `-(dueDay - today)`, so positive is days overdue and negative is days still to run. The
  old `needsAttention` tested `<= 0` and therefore flagged follow-ups scheduled for next
  week while skipping the ones already late; `followUpDue()` here is the corrected reading,
  matching `/lifecycle`'s.
- **`views.ts`** — the saved-view filter DSL behind the "New view" builder and the sidebar's
  VIEWS rows. Five fields (`status`, `owner`, `loop`, `category`, `todo`), two ops, AND only,
  and `validate.ts` imports the closed sets to whitelist them. **Evaluated in JS against
  contacts the loader already fetched — never compiled into SQL.** `todo` is the one derived
  field, and the one whose membership changes as work gets done: logging the call takes a
  contact out of a "Calls to make" view.
- **`ui.tsx`** — presentation primitives. `css(string)` parses an inline CSS **string** into a
  React style object (the app keeps the original template's style strings verbatim). `Box` is
  a polymorphic element (`as=...`, any element type — the sidebar passes `Link`) that adds
  `hover`/`focus` style merging via local state. Plus a set of inline SVG icon components,
  and the shell constants both pages share: `GLOBAL_CSS`, `MONO`, and `crmFontLinks` (the
  Geist webfonts — **every route rendering the CRM shell must re-export it as `links`**, or
  the page silently falls back to the root route's Inter).
- **`sidebar.tsx`** — the shared left rail: the
  Contacts/Analytics/Lifecycle/Deals/Templates/Smartlead/Settings nav (a
  **vertical** stack — seven items don't fit a segmented control; every item carries
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
  derived metrics: "replied" and "meetings" are read off the contact's *current* pipeline
  status rather than from an event log. A reply IS now an event (`contact_replies`, plus a
  touchpoint — see "Replies" below), but this metric deliberately still reads the status:
  it counts contacts *at* the replied stage, not replies received, and someone who answered
  and then booked belongs in the later bucket only. Bookings still have no event at all.
- **`analytics-page.tsx`** — the `/analytics` UI. Read-only (no fetcher, no action). Charts are
  plain divs with percentage widths/heights — there is no charting dependency, deliberately.
  It renders **two tabs over one shell**: *Pipeline* (everything `analytics.ts` computes) and
  *Email campaigns* (`campaigns-panel.tsx`). Tabs rather than two routes because both share
  the sidebar, the OWNER filter and the loader's single `now`. The **two rails agree on the
  loop**: a sidebar Loop row moves the campaign tab's switch and the switch writes the
  sidebar view back, so they can never contradict each other on screen. "All contacts" keeps
  the last chosen loop, because a campaign is per-loop by schema (migration 0009) and there
  is no "both" campaign to show.
- **`campaigns.ts`** — pure, isomorphic campaign aggregation (`computeCampaigns`), the same
  contract as `analytics.ts`: no React, no server imports, **no `Date`**. It reads **three
  sources that must not be confused**, and the page captions say which is which.
  *Email events* (migration 0022) are the good source: every headline figure, the daily
  sends/opens/clicks chart and the step table read them whenever the campaign has been synced
  since that migration, and every count is **unique leads**, matching Smartlead's own
  reporting — one lead who opened eight times is one open. *Contacts* answer the progress
  breakdown, which is a CRM question ("how far through the sequence is my book") rather than
  a Smartlead one, and they back the fallback chart; campaign sends are told from a rep's
  hand-logged email touch by note prefix (`SEND_NOTE_PREFIX` / `REPLY_NOTE_PREFIX`,
  **imported by the two writers in `crm.server.ts` rather than duplicated there**), which is
  the only signal there is. *Template variant counters* back the step table **only as a
  fallback** for a campaign not yet synced since 0022 — they carry meetings, which events do
  not, and no clicks at all. **The fallback is the point**: without it every campaign would
  read as zero until its next sync, which looks exactly like a campaign that has stopped
  working, so `fromEvents` travels to the page and the captions name the source. The progress
  buckets are a real partition of their cohort and their *evaluation* order is not their
  display order — replied first (a reply stops the sequence), then no-email (nothing can ever
  be sent), then the send count against the sequence length.
  **That cohort is the leads PUSHED to the campaign, not the loop.** `pushedContactIds` (the
  same `listPushedContactIds` read /smartlead's push guard uses) travels from the loader, and
  every denominator in the progress panel — the row shares, the bar widths and `capacity` —
  comes from it, because "campaign progress" asks how far the campaign has worked through
  what it was *given*. Counting the loop instead made a campaign holding 348 leads report
  "320 of 801", so a sequence most of the way through its book read as barely started, and
  the gap widened every time somebody added a contact the campaign had never heard of. The
  pushed set is **not** intersected with loop membership — a contact taken off the loop after
  being pushed is still a lead the campaign sends to, and dropping them would put the
  denominator below the sends that already went out. `null` (no campaign bound) falls back to
  the loop's contacts, since "0 of 0" says less than the book this loop would push; a bound
  campaign with nothing pushed is a different case and does read as zero, with a caption
  saying which. The KPI tiles still count the loop — they are labelled "on this loop".
- **`campaigns-panel.tsx`** — the Email campaigns tab's UI: campaign header, progress
  breakdown, KPI tiles, a 14-day grouped chart, per-step performance cards and a
  sending-by-owner table. A plain mapper, same as `analytics-page.tsx`. Its style constants
  are local rather than imported from `analytics-page.tsx` — importing back would make the
  two circular, and per-file `CARD`/`COL_LABEL` is already the convention (see
  `prospecting-panel.tsx`). One rule worth keeping: `StatBox` renders **nothing** for a null
  value rather than a zero, because the two step sources carry different figures (events have
  clicks and no meetings, the counters the reverse) and printing 0 for something never
  measured is worse than leaving the box out.
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
- **`unipile-map.ts`** — pure, isomorphic translation from Unipile's model, the same
  contract as `smartlead-map.ts`: no React, no server imports, **no `Date`**. It holds the
  whole answer to *whose reply is this* — `buildContactIndex` plus `matchEmail` /
  `matchLinkedin` — and every rule in it errs toward NOT matching, because a wrong match
  moves someone else's contact to `Replied` and puts a stranger's words on a card with their
  name on it. Three rules in order: exact email address, exact LinkedIn profile slug
  (`linkedinSlug` handles every shape the free-text `linkedin` column actually holds), then
  name — and the name rule is guarded twice, refusing an ambiguous name (this book really
  does hold the same name under two owners; see `hasNameConflict`) and refusing any contact
  whose stored profile URL *disagrees* with the attendee's. **Ambiguity is resolved at index
  build time, not at lookup**: a key held by two contacts is dropped from its table
  entirely, so a lookup can only return a unique holder. Also `REPLY_PROMOTES_FROM` (the
  mirror of `SENT_PROMOTES_FROM`), `toSnippet` (which cuts quoted history, or every card
  would preview our own outbound copy back at us) and the `ReplyCard` loader/UI contract.
- **`settings-page.tsx`** — the `/settings` UI, same one-client-component idiom. Account
  info, "sign out everywhere", and the Unipile section. It renders **two different account
  lists and always says which one**: before Load accounts it shows the sync's own
  bookkeeping (last synced, last result, and no health at all), after it the live list with
  Unipile's per-source status. Blurring them would print "Connected" over a LinkedIn session
  that expired overnight. Destructive actions use an inline two-step rather than the modal
  shells `/` and `/templates` use — those exist to summarise a bulk selection the row can't
  show, and here the target *is* the row.
- **`smartlead-map.ts`** — pure, isomorphic translation to Smartlead's model
  (`buildSequencePlan`, `toHtmlBody`, `planLeads`, `planImport`, `planSenders`,
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
  card per loop: campaign binding, the mailboxes it sends from, the sequence builder,
  contact eligibility, schedule, stats. The builder (`SequenceBuilder`) is a reorderable step list — native HTML5 drag
  plus ↑/↓ buttons as the **keyboard path**, the same pairing `lifecycle-page.tsx`
  documents — with a per-step variant chip, an editable wait, an expandable copy preview
  and a template picker. The expanded preview also carries an **Edit** button per variant,
  which writes back through the *same* `saveVariant` the Templates page uses — the copy has
  one home (`template_variants`) and this is a second door onto it, not a second store, so
  the caption says so and the editor is held open by variant id (two steps showing variant
  A are showing the same text). Saving reaches D1 only: the campaign keeps sending the old
  copy until the sequence is uploaded again, which the result message states. The action
  returns `closed: "editor"` so *only* that save closes the editor — closing on every
  successful write would discard a half-typed body the moment someone pressed an arrow on
  another row. Every edit **posts and waits**; there is no local draft of the
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
  optimistic UI). Contains all views: sidebar filters, the To do list, contact
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
`handleContactIntent(form, {DB, user, ...})` switch over the fourteen intents (`setStatus`,
`logTouch`, `addNote`, `logMeeting`, `snooze`, `clearFollow`, `addContact`, `resumeLoop1`,
`markAdsSent`, `deleteContacts`, `importContacts`, `triggerAgent`, `markReplyRead`,
`markAllRepliesRead`), shared by `/`, `/lifecycle` and `/settings`. The two reply intents
are in here rather than on the contacts route because they are pure D1 writes that any page
rendering a reply card needs; the *sync* that produces those cards is not, and stays on the
routes where its key and its rate limit live. It returns `null` for an unknown intent so each route keeps its own default.
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
six things: choosing which of the account's mailboxes the campaign sends from, building
the sequence out of templates from the Templates page, pushing
contacts in as leads, uploading that sequence as the campaign's steps, setting the sending
schedule, and a manual sync that reads back what the campaign actually sent — onto the
template variant counters, and onto the contacts it emailed. There is
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
- **`migrations/0015_smartlead_lead_sends.sql` — pushing a lead is not sending it.** A
  `smartlead_leads` row is written the moment Smartlead accepts the lead; the campaign then
  sends on its own schedule, paced by `max_new_leads_per_day`, and a paused campaign or a
  suppressed address means some pushed leads are never emailed at all. So "Sync stats" has a
  second half: the same `/statistics` rows it totals by step are also grouped by
  `lead_email` (`sendsByLead`), and every send Smartlead reports is written back onto the
  **contact** — one `email` touchpoint per send, and a contact still marked `New` moves to
  `Contacted` (`planContactSends` → `recordContactSends`). Before this, a contact pushed
  months earlier still read `New` everywhere in the CRM.
  - **`emailed_steps` is a JSON array of send keys, not a count.** The key is the
    `sequence_number` (`s:3`), or `t:<sent_time>` when the row carries no usable one. Keying
    on the step is what makes pressing Sync twice a no-op rather than a second timeline
    entry, without assuming the pages come back in the same order.
  - **The two halves of the sync fail differently, so only one of them is all-or-nothing.**
    Template counters are absolute lifetime totals, so a campaign larger than
    `SMARTLEAD_STATS_MAX_PAGES` writes *nothing* (a partial aggregate reads as a collapse in
    performance). A contact's "we emailed this person" is per-person and keyed on the step:
    a short read marks fewer people, never the wrong one, and the next press picks up the
    rest. Contact marking therefore runs first and is gated by neither the page budget nor
    "no uploaded steps to attribute numbers to".
  - **`SENT_PROMOTES_FROM` is `{New}` only** — the mirror of `PUSHABLE_STATUSES`. A step-3
    send arriving after someone replied must not walk `Replied`/`Meeting booked`/`Won`/`Dead`
    backwards. The `UPDATE` also carries `AND status = 'New'` rather than trusting the
    snapshot the plan was built from, and the reported count comes from `meta.changes`, so a
    status changed mid-sync loses the race rather than winning it. A contact manually set
    back to `New` after its sends were logged is left alone: `markContacted` needs a *new*
    send.
- **`migrations/0022_smartlead_email_events.sql` — the same read, stored instead of summed.**
  `GET /campaigns/{id}/statistics` returns one row per email carrying `stats_id`,
  `lead_email`, `sequence_number`, `sent_time`, `open_time`, **`click_time`**, `reply_time`,
  `open_count`, `click_count`, **`lead_category`**, `is_bounced` and `is_unsubscribed` — and
  the sync paged through every one of them while keeping only three timestamps. Clicks,
  sentiment, bounces and unsubscribes were read over the wire and thrown away, and because
  only totals survived there was no way to ask "how many went out last Tuesday". Storing the
  rows costs **no extra API call**.
  - **This does not contradict 0009's "derive, don't store".** That rule is about Smartlead's
    *configuration* — status, schedule, sequence numbering — which someone can change in
    Smartlead's UI at any moment, so a mirror would render something false. An email that was
    sent on a date and opened at a time is a historical fact that cannot change. Same
    distinction 0021 draws by storing replies but refusing to mirror the account list.
  - **`stats_id` is the idempotency key**, so this half of the sync is written **page by page
    and is gated by no budget at all** — a short read stores fewer emails, never wrong ones.
    It is an **upsert**, unlike every other idempotent write in `crm.server.ts`: those record
    that something happened and can never change, while an email sent yesterday and opened
    this morning legitimately comes back with a new `open_time`.
  - **Every headline read counts `DISTINCT lead_email`, never rows.** `is_positive` is a
    property of the *lead*, repeated on each of their rows, so counting rows would report a
    lead who received four emails as four positive replies. The per-step table is the one
    place rows are counted, because there one row is one email of that step.
  - **`is_positive` is resolved at sync time from `GET /leads/fetch-categories`**, whose
    `sentiment_type` is the only thing that knows a team's own "Warm intro" is positive.
    That call failing is **not** fatal: categories are still stored verbatim, `is_positive`
    stays 0, and the sync's result line says sentiment could not be read — rather than the
    page reporting zero positives as if that were the finding.
  - **Day bucketing is `substr(<ts>, 1, 10)`**, the UTC date prefix of Smartlead's ISO
    timestamps, joined against `buildAnalyticsLabels`' new `dayKeys`. Both sides bucket on
    UTC midnight; change one and change the other.
- **Sync timestamps are written as ISO strings from JS**, not via `datetime('now')`. The
  loader `Date.parse`es them to build a label, and SQLite's default has no timezone
  designator, so the column default would read a UTC instant as local time. `created_at`
  keeps the default because it is only ordered on, never parsed — except on the backdated
  touchpoints above, which set it explicitly and therefore go through `sqliteUTC()` to match
  `datetime('now')`'s exact format. `listContacts` orders touchpoints by the raw string, so
  an ISO `…T09:00:00.000Z` next to a stored `… 09:00:00` would sort every backdated send
  after every logged touch on the same day.
- **`migrations/0023_smartlead_events_lead_index.sql` — the same rows, asked about a person.**
  0022's two indexes are both keyed on `campaign_id`, because /analytics always asks about one
  campaign. The contacts page asks the opposite: for every contact in the book, how far into a
  sequence did they open and did they answer — a `GROUP BY lead_email` across every campaign,
  which without an index is a full scan on `listContacts`, the app's busiest read. The column
  order `(lead_email, sequence_number, opened_at, replied_at)` makes it **covering**, so that
  query is an index-only scan. No new columns and no new writes; the sync's upsert maintains
  it. The fold onto contacts is done **in JS, not SQL**: the address is the only link (0022
  deliberately has no `contact_id`), so a join would be `LOWER(c.email) = e.lead_email` — no
  index on `contacts` can serve it, and it would silently drop every contact with no address,
  turning an engagement lookup into a filter on the contact list itself. It feeds exactly one
  thing: the To do list's `opened` rule (see `todo.ts` above).
- **The SENDERS section is a live read, not a mirror.** Which mailboxes a campaign
  rotates between is Smartlead's own state, so nothing about it reaches D1 and there is
  no migration behind it: `fetchSenders` reads `/campaigns/{id}/email-accounts` plus a
  paged `/email-accounts/`, `planSenders` splits them into assigned/available, and
  `assignSender`/`removeSender` re-read through the same helper afterwards rather than
  moving a row between two client-side lists. Three consequences. The section renders
  only once a campaign is linked, and shows nothing until the button is pressed — the
  loader still makes no Smartlead calls, so "not loaded" and "none assigned" are
  deliberately different captions. The fetched list is keyed on the campaign id it came
  from, so re-linking a loop doesn't leave the old campaign's rotation on screen. And
  **warmup reputation is Smartlead's percentage, printed verbatim** — `warmupTone`'s
  bands are ours and colour the dot only, which is why the figure is always beside it.
  Emptying the rotation is allowed (swapping every mailbox has to pass through zero) and
  said out loud, because Smartlead reports a campaign with no sender as nothing
  happening rather than as an error. Nothing here buys or connects a mailbox: assigning
  what already exists upstream is the same bargain the campaign and template bindings make.
- **`pushSequence` pauses the campaign and leaves it paused.** Smartlead refuses sequence
  edits on an ACTIVE campaign with an opaque 400, so the pause is required; not
  auto-resuming is a choice — silently restarting sends right after the copy changed
  isn't a button's decision, and it removes the failure mode where a failed auto-restore
  leaves a live campaign paused with no signal.
- **A single Smartlead step can't be split per variant.** The `/statistics` rows carry a
  `sequence_number` but no variant id, so a step uploaded as an A/B split is skipped by
  name. (This limits the *counters* only. /analytics' step table reads the 0022 event rows,
  which carry their own `sequence_number` and need no attribution, so an A/B step does get
  real per-step numbers there — just not per variant.) A step the builder has **pinned** to a slot is one variant by construction, so its
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

## Replies (Unipile)

The inbound half. Everything this CRM *sent* was already visible; nothing told it when
somebody answered. `/settings` connects the team's mailboxes and LinkedIn through
**Unipile** (unipile.com — one key across every provider), and a **Sync replies** button
reads what has arrived, matches it to contacts, and files it. There is deliberately **no
cron and no inbound webhook** — the same rule Smartlead follows, and it is why there is no
public unauthenticated endpoint to defend.

Where a reply ends up: a card on the contacts page's **New replies** strip, a touchpoint on
the contact's timeline, and a status move to `Replied` for anyone still at `New` or
`Contacted`.

- **Two settings, different kinds.** `UNIPILE_API_KEY` is a secret; `UNIPILE_DSN` is the
  per-customer API host (`https://apiN.unipile.com:PORT`) and is not a credential, so it
  lives in `wrangler.toml [vars]` — the same split `ORIGAMI_PROJECT_ID` makes. Requests to
  the wrong DSN 404 rather than failing usefully, so both are required and the page reports
  them as two separate failures. Unlike Smartlead the key is an **`X-API-KEY` header**, so
  it is never in a URL and no `redact()` is needed.
- **`app/lib/unipile.server.ts`** — the HTTP client, shaped like `smartlead.server.ts`:
  never throws, returns a result, missing config = disabled, no retries. `normalizeDsn`
  accepts the three shapes the dashboard shows and **refuses anything but https** — that
  value is the host every keyed request is sent to, so a quietly wrong DSN is a key handed
  to a stranger.
- **`app/lib/unipile-sync.server.ts`** — one sync, called by both pages. Reads accounts
  live, then per account reads forward from that account's watermark. **One account's
  failure is not the sync's**: each is read, written and stamped independently, because a
  LinkedIn session needing re-login is the likeliest thing to go wrong and must not stop the
  mailboxes.
- **`migrations/0021_unipile_replies.sql`** — `unipile_accounts` (a watermark per account,
  bookkeeping only) and `contact_replies` (history). The **account list is not mirrored**,
  for the reason /smartlead's SENDERS section isn't: a cached copy renders "connected" for a
  session that expired an hour ago. The unique `(account_id, provider_message_id)` index is
  the real idempotency guard.
- **An ignored insert is still a successful statement**, which is the subtle part of
  `recordReplies`. `INSERT OR IGNORE` stops a duplicate *row*, but a blind follow-up would
  still write the touchpoint and re-promote the contact, so a second Sync would double the
  timeline. It reads back `RETURNING id` and writes the other two only for rows that landed.
- **The watermark never goes backwards** (`MAX()` in the upsert, not assignment) — two
  people pressing Sync at once would otherwise let the slower one rewind it — **and it does
  not advance on a truncated read**. Unipile returns newest-first, so a read that stopped at
  its page budget covered the *recent* end and left the older end unexamined; advancing past
  it would step over those messages permanently. Staying put costs a repeated read, which
  the unique index makes free. The escape hatch for an account stuck that way is the
  per-account **"Re-read last N days"**, which clears the watermark deliberately — an
  operator's decision to skip a backlog, never the sync's.
- **`role: "inbox"` and `is_sender` are the whole reply filter.** Without them the same
  calls return our own outbound, which then matches the contact it was addressed to and is
  logged as their reply. `ownAddresses` closes the third case: mail from one connected
  mailbox to another.
- **LinkedIn costs three calls, not one.** A message carries a `sender_attendee_id` and
  nothing else about the person; only the chat's attendee list turns that into a name and a
  profile URL. Hence `UNIPILE_MAX_CHATS`, and hence chats being resolved newest-first.
- **Unmatched replies are counted, not stored.** The sync says "3 from people not in the
  CRM", which is what distinguishes a quiet inbox from a matching rule that has stopped
  working. `matched_on` records which rule fired, and is the only way to diagnose a wrong
  match after the fact.
- **The first sync of an account reads `UNIPILE_FIRST_SYNC_DAYS` back, not everything.**
  That is a correctness bound, not a performance one: a mailbox holds years of
  correspondence with people who are also contacts, and reading all of it would stamp
  three-year-old "Replied" touchpoints across half the book.
- **The connect link is returned, not redirected to.** `form-action 'self'` is enforced
  across redirects, so a 302 out of the action to Unipile's domain is blocked with no
  visible error; the client assigns `window.location` instead. Worth remembering before
  "simplifying" it back into a `redirect()`.
- **Nothing was added to `/api/hyperagent`**, for the reason Smartlead added nothing: a
  bearer token that could read the team's inbox is not a thing to hang off a shared key.

Security headers (CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS on https, etc.) are set in
`workers/app.ts`, wrapping every dynamic response. They do **not** apply under
`npm run dev` (the Vite dev server doesn't route through the Worker entry) — use
`npm run start` to see them.

Gotchas:
- **Touchpoints are written by five paths**: the `logTouch` intent (the detail panel's "Log
  touch" channel chips), `logMeeting`, the bulk `markAdsSent`, `recordContactSends` from
  the Smartlead sync, and `recordReplies` from the Unipile sync. The first three only
  reflect activity logged in-app; the last two backfill, and only for campaigns this CRM
  pushed to and mailboxes connected to Unipile — so the analytics channel and activity
  panels still start sparse for anything sent or received elsewhere. The two sync writers
  are the only ones that can move a contact's status as a side effect, and they move it in
  opposite directions along the same guarded edge: `Contacted` on a send, `Replied` on a
  reply, each with the promotable set spelled out in SQL. The touch-based `hasConflict`/`peopleInvolved` still rarely fire; the
  live conflict flag remains the name-based `hasNameConflict`/`conflictOwners`.
- **Two touchpoint note prefixes are load-bearing.** `recordContactSends` writes
  `Sent by X` / `Sent step N of X` and `recordReplies` writes `Replied from X`, and
  /analytics' Email campaigns tab tells a campaign send from a rep's hand-logged email touch
  by that prefix and nothing else. Both writers import the constants from
  `app/crm/campaigns.ts`; change the text there, not inline, or the tab silently starts
  counting zero sends.
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
but access is restricted to five hardcoded addresses.

- **`app/lib/allowlist.ts`** — the five permitted emails mapped to display names. Isomorphic
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
  disables `/smartlead`; never a `[vars]` entry, since it travels in request URLs),
  `ORIGAMI_API_KEY` and `UNIPILE_API_KEY` (optional — empty disables the Prospect panel and
  the reply sync respectively). `AUTH_EMAIL_FROM`, `ORIGAMI_PROJECT_ID` and `UNIPILE_DSN`
  are `[vars]` entries, not secrets: the first must have a Resend-verified domain, and the
  last two only *scope* a request rather than authorise one.
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
