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
3. `app/routes.ts` — route table: index → `routes/home.tsx`, plus `/login`, `/logout`,
   `/api/auth/*` (better-auth's handler) and `/api/hyperagent`.
4. `app/root.tsx` — HTML document shell (`Layout`), root `Outlet`, and `ErrorBoundary`.
5. `app/routes/home.tsx` — the index route's `loader` requires a session then reads contacts
   from D1 (`listContacts`), the `action` re-checks the session and handles intent-dispatched
   writes, and the default export renders
   `<SalesLoopCRM contacts={loaderData.contacts} viewer={loaderData.viewer} />`.

`app/entry.server.tsx` is the standard streaming SSR entry (`renderToReadableStream`,
5s `streamTimeout`, bot-detection via `isbot`).

## The CRM (`app/crm/`)

The whole product lives in three files:

- **`data.ts`** — the model and constants. Types (`Contact`, `Touch`, `Note`), constants
  (`CH` channels, `STATUSES`, `OWNERS`), and pure helpers:
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

**Input validation lives in `app/lib/validate.ts`** — shared by the session action
(`home.tsx`) and the machine API (`api.hyperagent.ts`), which previously disagreed about what
was acceptable. It owns the field length limits (`LIMITS`), the import/bulk-id caps, the
`status`/`owner`/`loop`/touch-type whitelists, the email format check, and two output
escapers: `csvCell` (RFC 4180 quoting **plus** neutralizing a leading `= + - @ \t \r`, which
Excel and Sheets execute as a formula) and `safeMailto` (returns null unless the address is
plain, so a stored `…?bcc=…&body=…` can't prefill an attacker's draft). It is isomorphic —
the client imports `LIMITS` for `maxLength` and the CSV caps. **Add new write paths through
this module rather than validating inline.**

Deletion is recorded in an append-only `audit_log` table with a JSON snapshot of each removed
row and the acting user — contact deletion is a hard delete that also drops the contact's
notes and touchpoints, on a dataset shared by all four users.

Security headers (CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS on https, etc.) are set in
`workers/app.ts`, wrapping every dynamic response. They do **not** apply under
`npm run dev` (the Vite dev server doesn't route through the Worker entry) — use
`npm run start` to see them.

Gotchas:
- **No touchpoint write path.** Nothing inserts into the `touchpoints` table yet, so
  `touches` is always `[]`: the "Last touch" column and the detail timeline render empty, and
  the touch-based `hasConflict`/`peopleInvolved` never fire (the live conflict flag is instead
  the name-based `hasNameConflict`/`conflictOwners`). Logging touchpoints is the natural next
  feature.
- Index-route **actions require `?index`** in the POST URL (the client's `useFetcher` adds it
  automatically; a raw `curl` to `/` hits the layout route and 405s).

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
  production build if unset) and `RESEND_API_KEY`. `AUTH_EMAIL_FROM` is a `[vars]` entry; its
  domain must be verified in Resend or nothing sends.
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
