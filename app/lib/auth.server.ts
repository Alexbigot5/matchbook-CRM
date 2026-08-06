import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { displayNameFor, isAllowed } from "./allowlist";
import { sendSignInEmail, type EmailEnv } from "./email.server";

// Magic-link auth over D1, gated to the four addresses in allowlist.ts.
//
// `database` is handed the raw D1 binding: better-auth duck-types it
// (`"batch" in db && "exec" in db && "prepare" in db`) and loads its own bundled
// D1SqliteDialect, so kysely-d1 is not needed. Passing a bare dialect instead
// would leave the adapter unable to detect the database type and fall back to a
// default rather than positively identifying sqlite.

export type AuthEnv = EmailEnv & {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
};

/** How long a sign-in link stays valid. */
export const MAGIC_LINK_TTL_SECONDS = 60 * 15;

/** Absolute session lifetime. Re-authenticating weekly is not a burden at four users. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** How often an active session's expiry is pushed forward. */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export function createAuth(env: AuthEnv, baseURL: string) {
  // Assert rather than trust the library's guard. better-auth only *throws* on a
  // missing secret when it also believes it is in production — its check is
  // `secret === DEFAULT_SECRET && !isProduction ? warn : throw`, keyed on
  // NODE_ENV. If NODE_ENV isn't "production" inside the deployed isolate it
  // silently falls back to a publicly published default secret, which means
  // forgeable session cookies and a total auth bypass. Vite normally inlines
  // NODE_ENV so this is unlikely — but the safety of the whole auth system
  // should not rest on an assumption this repo never checks.
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Refusing to start auth with a default secret — " +
        "run `openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET`.",
    );
  }

  return betterAuth({
    database: env.DB,

    // Per-request origin (see load-context.ts). Getting this right is what makes
    // the `secure` cookie flag correct in every environment: better-auth derives
    // it from the baseURL protocol, so http://localhost gets a non-secure cookie
    // while production gets a secure one, with no environment-specific config.
    baseURL,

    // Must be explicit. better-auth throws outright when the built-in default
    // secret is used in a production build, so an unset value is a hard 500 on
    // every request rather than a warning.
    secret: env.BETTER_AUTH_SECRET,

    // Off deliberately. Mounting the handler publishes every enabled endpoint —
    // leaving this on would expose POST /api/auth/sign-up/email, a public
    // account-creation route that bypasses the magic-link gate entirely.
    emailAndPassword: { enabled: false },

    // cookieCache off deliberately. The cached session cookie would keep a
    // revoked user live for up to 5 minutes without touching D1. At four users a
    // read per request costs nothing, so take the correctness.
    //
    // expiresIn/updateAge are explicit because the defaults (7d sliding, renewed
    // daily) have no absolute cap — an active session renews forever and the
    // user is never re-authenticated. These are the same numbers, stated rather
    // than inherited, so a library default change can't quietly extend them.
    session: {
      cookieCache: { enabled: false },
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },

    // The default limiter stores counters in a module-level Map. On Workers that
    // is per-isolate and evicted constantly, so it does not actually limit
    // anything — "database" puts them in D1 where every isolate sees them.
    // Note this only covers the /api/auth/* handler; POST /login calls the
    // server API directly and is metered separately (see app/lib/ratelimit.server.ts).
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
    },

    // Without this better-auth cannot resolve a client IP on Workers and logs
    // "falling back to a single shared per-path bucket" — meaning all four users
    // (and every unauthenticated caller) share one 30-per-minute counter, so one
    // noisy client locks everyone out of sign-in. CF-Connecting-IP is set by
    // Cloudflare's edge and cannot be spoofed by the client, which is the same
    // header app/lib/ratelimit.server.ts trusts.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },

    // Pin the origins allowed to receive a redirect and mint a sign-in link.
    // baseURL is derived per request, so without this any host routing to this
    // Worker — including the default *.workers.dev subdomain — could issue a
    // real magic link pointing at itself.
    trustedOrigins: [baseURL],

    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, url }) => {
          // Layer 2 (see below) — belt and braces if the middleware is ever
          // bypassed, so no mail can leave for a non-allowlisted address.
          if (!isAllowed(email)) return;
          await sendSignInEmail(env, email, url, MAGIC_LINK_TTL_SECONDS);
        },
      }),
    ],

    // ---------------------------------------------------------------------
    // The allowlist is enforced at four independent layers:
    //   1. the /login action, before better-auth is called at all;
    //   2. `hooks.before` here — catches direct POSTs to the public
    //      /api/auth/sign-in/magic-link endpoint the splat route exposes;
    //   3. `databaseHooks.user.create.before` — no non-allowlisted `user` row
    //      can ever be written, even if 1 and 2 were bypassed;
    //   4. requireUser() on every loader/action — so removing an email revokes
    //      access on the next request despite a still-valid session cookie.
    // Layer 2 is the important one for "never email a stranger": it runs before
    // the verification row is created *and* before sendMagicLink.
    // ---------------------------------------------------------------------
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/magic-link") return;
        const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "");
        if (!isAllowed(email)) {
          throw new APIError("FORBIDDEN", {
            message: "This email address isn't authorized for Matchbook CRM.",
          });
        }
      }),
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Returning false aborts creation; magic-link then redirects with
            // ?error=failed_to_create_user.
            if (!isAllowed(user.email)) return false;
            // Stamp the display name from the allowlist so notes are authored
            // under "Alex"/"Tom"/... rather than an email local-part.
            return { data: { ...user, name: displayNameFor(user.email) } };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
