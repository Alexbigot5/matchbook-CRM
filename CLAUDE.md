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
npm run db:migrate:local   # apply schema.sql to local D1
npm run db:migrate:remote  # apply schema.sql to remote D1
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
5. `app/routes/home.tsx` — renders `<SalesLoopCRM />` and sets page `meta`/`links`.

`app/entry.server.tsx` is the standard streaming SSR entry (`renderToReadableStream`,
5s `streamTimeout`, bot-detection via `isbot`).

## The CRM (`app/crm/`)

The whole product lives in three files:

- **`data.ts`** — the model and seed data. Types (`Contact`, `Touch`, `Note`), constants
  (`CH` channels, `STATUSES`, `OWNERS`, `VIEWER = "Tom"`, `TODAY`), a small **seeded RNG**
  (`rng(42)`), and `buildData()` which deterministically generates ~30 fake contacts. Also
  pure helpers: `needsAttention`, `hasConflict`, `statusMeta`, `loopBadge`, `statusPill`,
  date formatting (`ago`, `fmtDate`, `dateFrom`).
  **Determinism matters**: data is seeded and `TODAY` is fixed so SSR and client render
  identically (no hydration mismatch). Don't introduce `Date.now()`/`Math.random()` into the
  render path.
- **`ui.tsx`** — presentation primitives. `css(string)` parses an inline CSS **string** into a
  React style object (the app keeps the original template's style strings verbatim). `Box` is
  a polymorphic element (`as=...`) that adds `hover`/`focus` style merging via local state.
  Plus a set of inline SVG icon components.
- **`sales-loop-crm.tsx`** — the entire app as **one ~920-line client component**. Single
  `useState` "God object" (`State`) patched through a `patch()` helper; a `nidRef` for new
  IDs. Contains all views (sidebar filters, "Needs attention" queue, contact table, detail
  slide-over, add/CSV-import modals) and all handlers (status changes, notes, follow-ups,
  CSV parsing). No routing, no server calls.

### Two "loops" domain concept
- **Loop 1** — always-on outbound (grey badge).
- **Loop 2** — event/community blitz (amber badge).
A contact can be in one or both. Owners are **Tom** and **Britton**; a contact touched by
both surfaces a "conflict" warning.

## Data: important gotcha

The running UI is **entirely in-memory**. `buildData()` seeds React state; adds/edits/imports
mutate `useState` only. Nothing reads or writes D1 yet.

`schema.sql` (tables `contacts`, `touchpoints`, `notes`) and the better-auth setup exist as
scaffolding for a future persistence layer but are **not wired to the UI**. If you're asked to
"make it persist" or "load from the database," that work does not exist yet — you'd add
loaders/actions in the route (reading `context.get(appContext).DB`) and replace the
`buildData()` seed. Also note the `schema.sql` column names (snake_case, e.g. `last_touchpoint`,
`loop1_resumed_at`) don't yet match the richer in-memory `Contact` shape in `data.ts`.

## Conventions

- **Inline-style strings** passed through `css("...")`, not Tailwind classes, throughout the
  CRM. Match that style when editing CRM components. Tailwind is only meaningful in
  `app/root.tsx` / `app/welcome/`.
- **`~/*` path alias** → `app/*` (see `tsconfig.json`).
- Use `Box` for anything needing hover/focus styling; raw elements otherwise.
- Route modules import generated types from `./+types/<route>` — run typegen before tsc.

## Files that are NOT the app (ignore unless relevant)

- `Sales Loop CRM (standalone) (4).html` — the original ~370KB standalone HTML prototype the
  React app was ported from. Reference/design source only; not part of the build.
- `app/welcome/` — leftover React Router starter scaffold. Not referenced by `routes.ts`.
- `crm-app/` — gitignored leftover from an earlier migration.

## Deployment

Cloudflare Workers via Wrangler (`wrangler.toml`): worker name `matchbook-crm`, D1 database
`crm-db` bound as `DB`, static assets served from `./build/client`. `Env` (the worker
bindings type) is generated by Wrangler into `worker-configuration.d.ts` (gitignored).
