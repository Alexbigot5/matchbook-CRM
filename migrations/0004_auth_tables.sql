-- better-auth core tables (user / session / account / verification).
--
-- Generated from better-auth 1.6.26's own `getMigrations()` against the config in
-- app/lib/auth.server.ts (magicLink plugin, emailAndPassword disabled) rather than
-- hand-written, so the columns match exactly what the runtime expects. Regenerate
-- if better-auth is upgraded or a plugin with its own schema is added.
--
-- Notes on the SQLite/D1 mapping:
--   * `emailVerified` is an integer (0/1) — the adapter reports supportsBooleans:false.
--   * `date` columns hold ISO-8601 strings, not numbers; SQLite's NUMERIC affinity
--     leaves non-numeric text as TEXT, so they round-trip unchanged.
--   * Identifiers are quoted camelCase to match the generated DDL verbatim.
--   * The magicLink plugin adds no tables of its own — it writes rows into
--     `verification`. Expired rows there are never swept; harmless at this scale.

CREATE TABLE IF NOT EXISTS "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL,
  "image" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
