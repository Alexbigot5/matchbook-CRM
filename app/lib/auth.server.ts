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

export function createAuth(env: AuthEnv, baseURL: string) {
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

    // Off deliberately. The cached session cookie would keep a revoked user live
    // for up to 5 minutes without touching D1. At four users a read per request
    // costs nothing, so take the correctness.
    session: { cookieCache: { enabled: false } },

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
