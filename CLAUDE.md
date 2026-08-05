# CLAUDE.md

Guidance for working in this repo. This is **matchbook-crm** — a "Sales Loop CRM":
a two-loop outbound sales tool (queue, contact list, touchpoint history) built as a
React Router SSR app deployed to Cloudflare Workers.

## Stack

- **React Router v8** (`ssr: true`) — full-stack framework mode, not the library.
- **Cloudflare Workers** runtime (`workers/app.ts` is the entry), with `nodejs_compat`.
- **Cloudflare D1** (SQLite) via the `DB` binding — provisioned but see "Data" below.
- **better-auth** (email + password) over D1 via `kysely-d1` — wired up, not yet used by any UI.
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
2. `load-context.ts` — defines the load context (`{ DB, auth }`). React Router v8 uses a
   `RouterContextProvider`, so **loaders/actions read context with `context.get(appContext)`**,
   not a plain `context.DB`. `appContext` is the exported `createContext` handle.
3. `app/routes.ts` — route table. Currently a **single index route** → `routes/home.tsx`.
4. `app/root.tsx` — HTML document shell (`Layout`), root `Outlet`, and `ErrorBoundary`.
5. `app/routes/home.tsx` — the index route's `loader` reads contacts from D1
   (`listContacts`), the `action` handles intent-dispatched writes, and the default export
   renders `<SalesLoopCRM contacts={loaderData.contacts} />` and sets page `meta`/`links`.

`app/entry.server.tsx` is the standard streaming SSR entry (`renderToReadableStream`,
5s `streamTimeout`, bot-detection via `isbot`).

## The CRM (`app/crm/`)

The whole product lives in three files:

- **`data.ts`** — the model and constants. Types (`Contact`, `Touch`, `Note`), constants
  (`CH` channels, `STATUSES`, `OWNERS`, `VIEWER = "Tom"`), and pure helpers:
  `needsAttention`, `hasConflict`, `statusMeta`, `loopBadge`, `statusPill`, date formatting
  (`ago`, `fmtDate`, `dateFrom`). The `Contact` shape (with relative `daysAgo`/`followUp`
  integers) is the contract between the server loader and the UI.
  **Determinism matters**: all date math happens server-side in the loader against a single
  `now`; the UI renders only from loader-serialized integers/labels, so SSR and client
  hydration match. Don't introduce `Date.now()`/`Math.random()` into the render path.
- **`ui.tsx`** — presentation primitives. `css(string)` parses an inline CSS **string** into a
  React style object (the app keeps the original template's style strings verbatim). `Box` is
  a polymorphic element (`as=...`) that adds `hover`/`focus` style merging via local state.
  Plus a set of inline SVG icon components.
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

Contacts, notes, and follow-ups **persist to Cloudflare D1**. `app/lib/crm.server.ts` is the
server-only data-access layer (raw D1 prepared statements, `crypto.randomUUID()` ids). It owns
all conversion between stored **absolute** timestamps and the **relative** `daysAgo`/`followUp`
values the UI renders — keeping every `Date` call server-side is what preserves SSR/hydration
determinism. The schema lives in `migrations/` (applied via Wrangler's D1 migrations, tracked
in a `d1_migrations` table) and mirrors the `data.ts` model: `contacts` stores `loops` as a JSON
text array, a nullable `follow_up_at`, a nullable `source`, and a nullable
`resumed_to_loop1_at`; `notes` uses a `text` column. The DB **starts empty** — contacts are
created via the UI / CSV import. **Schema changes:** run `npm run db:migrations:create <name>` to
scaffold a new numbered file in `migrations/`, add your `CREATE`/`ALTER` SQL, then apply it with
`npm run db:migrate:local` / `npm run db:migrate:remote`. Wrangler only runs migrations not yet
recorded in `d1_migrations`, so files are applied once, in numeric order.

Gotchas:
- **No touchpoint write path.** Nothing inserts into the `touchpoints` table yet, so
  `touches` is always `[]`: the "Last touch" column and the detail timeline render empty, and
  the touch-based `hasConflict`/`peopleInvolved` never fire (the live conflict flag is instead
  the name-based `hasNameConflict`/`conflictOwners`). Logging touchpoints is the natural next
  feature.
- **better-auth is still orphaned** — instantiated per request into context, but no handler is
  mounted and no auth tables exist. Login is not implemented; the app is a single shared
  dataset with `VIEWER = "Tom"` as the note author.
- Index-route **actions require `?index`** in the POST URL (the client's `useFetcher` adds it
  automatically; a raw `curl` to `/` hits the layout route and 405s).

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
