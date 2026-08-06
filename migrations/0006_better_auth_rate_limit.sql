-- better-auth's own rate-limit table.
--
-- Missed when 0004 was generated: `getMigrations()` only emits this table when
-- `rateLimit.storage === "database"` (see @better-auth/core get-tables.mjs —
-- `shouldAddRateLimitTable`), and the generator was evidently run against a
-- config that still used the default in-memory storage. auth.server.ts sets
-- storage: "database", so the runtime expects a table that no migration created.
--
-- The effect was a hard 500 on every request routed through better-auth's HTTP
-- handler, because the limiter runs before the endpoint and its first query is
-- against this table:
--     D1_ERROR: no such table: rateLimit: SQLITE_ERROR
-- That is why sign-in appeared to work while the magic link did not. POST /login
-- calls auth.api.signInMagicLink directly, bypassing the handler and therefore
-- the limiter, so the email sent normally — but the link in it points at
-- GET /api/auth/magic-link/verify, which goes through the handler and died here.
--
-- Do not confuse this with `rate_limits` from 0005: that is this app's own
-- limiter (app/lib/ratelimit.server.ts) covering POST /login and /api/hyperagent.
-- Two limiters, two tables, different owners. This one is better-auth's and its
-- column names are fixed by the library.
--
-- Column types are what better-auth's generator emits for sqlite:
--   * `key` is string+unique     -> text, UNIQUE
--   * `count` is number          -> integer
--   * `lastRequest` is number+bigint -> bigint (epoch ms, not an ISO date)

CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" text NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
