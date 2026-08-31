import type { Route } from "./+types/settings";
import { SettingsPage } from "../crm/settings-page";
import { appContext } from "../../load-context";
import { ownerAvatar } from "../crm/data";
import { crmFontLinks } from "../crm/ui";
import { requireUser } from "../lib/session.server";
import {
  countUnreadReplies,
  forgetUnipileAccount,
  getUnipileSyncState,
  listContacts,
  resetUnipileWatermark,
  type UnipileSyncState,
} from "../lib/crm.server";
import { handleContactIntent } from "../lib/contact-intents.server";
import { rateLimit, UNIPILE_RULE, UNIPILE_SYNC_RULE } from "../lib/ratelimit.server";
import { createUnipileClient, normalizeDsn } from "../lib/unipile.server";
import { listAccountViews, syncReplies, type AccountView } from "../lib/unipile-sync.server";
import { UNIPILE_FIRST_SYNC_DAYS, validateUnipileAccountId } from "../lib/validate";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Settings · Sales Loop CRM" },
    {
      name: "description",
      content: "Account settings and the Unipile connection that reads email and LinkedIn replies.",
    },
  ];
}

// Same webfonts as every other CRM page — see routes/templates.tsx.
export const links = crmFontLinks;

/**
 * Which providers each "Connect" button offers, as a closed set.
 *
 * A whitelist rather than free text because the value is posted to Unipile under
 * a live key, in the field that decides what kind of credential the hosted
 * wizard will ask the operator for. The two entries mirror the two channels this
 * CRM can actually read (see channelForProvider) — offering WhatsApp here would
 * connect an account the sync then silently ignores.
 */
const CONNECT_PROVIDERS: Record<string, string[]> = {
  mailbox: ["GOOGLE", "OUTLOOK", "MAIL"],
  linkedin: ["LINKEDIN"],
};

/** How long a minted hosted-auth link stays valid. */
const CONNECT_LINK_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  const { DB, UNIPILE_API_KEY, UNIPILE_DSN } = ctx;
  // Gating is per-route, so this page needs its own check.
  const user = await requireUser(request, ctx);
  const avatar = ownerAvatar(user.name);
  const now = Date.now();

  // NO Unipile calls here, deliberately — the same rule /smartlead's loader
  // follows. A loader that reaches a third party makes the page 500 whenever
  // that party is slow, and every operation on this page is a manual button.
  // `contacts` feeds the shared sidebar's counts and nothing else.
  const [contacts, syncState, unreadReplies] = await Promise.all([
    listContacts(DB, now),
    getUnipileSyncState(DB),
    countUnreadReplies(DB),
  ]);

  return {
    viewer: { name: user.name, initial: avatar.initial, color: avatar.color },
    email: user.email,
    contacts,
    unreadReplies,
    // What the last sync knew about each account. Rendered muted and captioned
    // as historical: it is bookkeeping, not a live account list, and the page
    // says which it is showing rather than letting a stale row claim an expired
    // LinkedIn session is connected.
    storedAccounts: Object.values(syncState).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    ) as UnipileSyncState[],
    unipile: {
      // Never the key itself — only whether one is set. The host is shown
      // because an operator debugging a 404 needs to see which server the CRM
      // is pointed at, and it is not a credential.
      hasKey: Boolean(UNIPILE_API_KEY),
      dsn: normalizeDsn(UNIPILE_DSN),
      dsnRaw: Boolean((UNIPILE_DSN ?? "").trim()),
      firstSyncDays: UNIPILE_FIRST_SYNC_DAYS,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * `connectUrl` is returned rather than redirected to, and that is a CSP
 * decision, not a style one. `workers/app.ts` sets `form-action 'self'`, which
 * browsers enforce across redirects — so a 302 out of this action to
 * account.unipile.com is blocked with no visible error. Handing the URL back and
 * letting the client assign `window.location` is an ordinary navigation, which
 * that directive does not govern.
 */
type ActionResult =
  | { ok: true; message?: string; accounts?: AccountView[]; connectUrl?: string }
  | { ok: false; error: string };

/**
 * Intents that reach nothing but D1 or a single cheap call.
 *
 * `signOutEverywhere` is in here deliberately, even though it is the weightiest
 * write on the page: metering it on the sync bucket would mean ten impatient
 * presses of Sync lock someone out of the control they reach for when a laptop
 * goes missing. A security action must not be rationed by an unrelated quota.
 */
const LIGHT_INTENTS = new Set([
  "signOutEverywhere",
  "fetchAccounts",
  "connect",
  "disconnect",
  "resetWatermark",
  "markReplyRead",
  "markAllRepliesRead",
]);

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionResult | Response> {
  const ctx = context.get(appContext);
  const { DB, UNIPILE_API_KEY, UNIPILE_DSN } = ctx;
  // Checked independently of the loader — otherwise every mutation below would
  // still be reachable without a session.
  const user = await requireUser(request, ctx);
  const form = await request.formData();
  const intent = form.get("intent")?.toString();

  // A sync is dozens of subrequests; everything else is one call or none. They
  // are metered on separate buckets for the reason SMARTLEAD_BUILDER_RULE is
  // separate from SMARTLEAD_RULE — clearing the strip must not exhaust the
  // allowance to refill it.
  const limit = await rateLimit(
    DB,
    LIGHT_INTENTS.has(intent ?? "") ? UNIPILE_RULE : UNIPILE_SYNC_RULE,
    user.email,
  );
  if (!limit.allowed) {
    return { ok: false, error: `Too many requests. Try again in ${limit.retryAfterSeconds}s.` };
  }

  try {
    switch (intent) {
      /**
       * Revoke every session this user holds, anywhere.
       *
       * The current device included — that is the point, and saying so on the
       * button is what makes it honest rather than surprising. better-auth's
       * revokeSessions deletes the rows; the cookie in this browser survives it
       * and would simply fail its next lookup, so signOut is called as well to
       * clear it and the response redirects to /login carrying those cookies.
       *
       * Returned as a Response rather than an ActionResult: there is no page
       * left to render a banner on.
       */
      case "signOutEverywhere": {
        const auth = ctx.getAuth();
        await auth.api.revokeSessions({ headers: request.headers });

        const headers = new Headers({ Location: "/login?signedOut=all" });
        try {
          const res = await auth.api.signOut({ headers: request.headers, asResponse: true });
          for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
        } catch (err) {
          // The session row is already gone — which is exactly what was asked
          // for. The redirect still happens and /login will not find a session.
          console.error("[settings] sign-out after revoke failed:", err);
        }
        return new Response(null, { status: 302, headers });
      }
    }

    // Everything below needs Unipile. Checked once, and reported as the two
    // separate failures it really is: a missing key and a missing host need
    // different things done about them.
    if (!UNIPILE_API_KEY) {
      return { ok: false, error: "Unipile isn’t configured. Set the UNIPILE_API_KEY secret." };
    }
    if (!normalizeDsn(UNIPILE_DSN)) {
      return {
        ok: false,
        error: "Unipile isn’t configured: UNIPILE_DSN is missing or isn’t an https URL.",
      };
    }
    const client = createUnipileClient(UNIPILE_API_KEY, UNIPILE_DSN);

    switch (intent) {
      case "fetchAccounts": {
        const res = await listAccountViews(DB, client);
        if (!res.ok) return { ok: false, error: res.error };
        return {
          ok: true,
          accounts: res.accounts,
          message: res.accounts.length
            ? undefined
            : "No accounts are connected to Unipile yet. Connect one below.",
        };
      }

      case "connect": {
        const kind = form.get("kind")?.toString() ?? "";
        const providers = CONNECT_PROVIDERS[kind];
        if (!providers) return { ok: false, error: "Pick what kind of account to connect." };

        const origin = new URL(request.url).origin;
        const res = await client.createHostedAuthLink({
          expiresOn: new Date(Date.now() + CONNECT_LINK_TTL_MS).toISOString(),
          providers,
          successRedirectUrl: `${origin}/settings?connected=1`,
          failureRedirectUrl: `${origin}/settings?connected=0`,
          // Unipile echoes this back on its notify webhook to identify the user.
          // Nothing here listens for that webhook (see migrations/0021), so it is
          // sent purely so the connection is attributable in Unipile's own
          // dashboard — which is where someone will look to ask "whose mailbox
          // is this?".
          name: user.email,
        });
        if (!res.ok) return { ok: false, error: res.error };

        const url = res.data?.url;
        if (!url || !/^https:\/\//i.test(url)) {
          return { ok: false, error: "Unipile didn’t return a connect link. Try again." };
        }
        return { ok: true, connectUrl: url };
      }

      case "disconnect": {
        const id = validateUnipileAccountId(form.get("accountId"));
        if (!id.ok) return { ok: false, error: id.error };

        const res = await client.deleteAccount(id.id);
        if (!res.ok) return { ok: false, error: res.error };
        // Only after Unipile has accepted it. Dropping the watermark first would
        // leave a still-connected account with no memory of what it had already
        // read, and the next sync would re-read the whole recent window.
        await forgetUnipileAccount(DB, id.id);

        // Said explicitly, because it is the question anyone pressing this asks
        // next: the replies already synced from this account are history and stay.
        return {
          ok: true,
          message: "Account disconnected. Replies already synced from it are kept.",
        };
      }

      case "resetWatermark": {
        const id = validateUnipileAccountId(form.get("accountId"));
        if (!id.ok) return { ok: false, error: id.error };
        await resetUnipileWatermark(DB, id.id);
        return {
          ok: true,
          message: `Watermark cleared. The next sync reads the last ${UNIPILE_FIRST_SYNC_DAYS} days of this account.`,
        };
      }

      case "syncReplies": {
        const res = await syncReplies(DB, {
          apiKey: UNIPILE_API_KEY,
          dsn: UNIPILE_DSN,
          actor: user.name,
        });
        if (!res.ok) return { ok: false, error: res.error };
        // Failures are appended rather than swallowed: one dead LinkedIn session
        // among four healthy mailboxes still produces a green banner otherwise,
        // and the account that needs re-login is the one nobody would notice.
        const failures = res.summary.failures.length
          ? ` ${res.summary.failures.join(" ")}`
          : "";
        return { ok: true, message: res.summary.message + failures };
      }
    }
  } catch (err) {
    // Log the real cause, return an opaque one. D1 exception text carries table,
    // column and constraint names, and this value renders straight into the UI —
    // the reference id ties the two together.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action:${intent}] ref=${ref}`, err);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }

  // The two reply intents live in the shared contact-intents module, so the
  // strip's "mark read" behaves identically wherever it is rendered. Layered
  // around the switch above exactly as /'s saved-view intents are — that helper
  // returns null for an intent it does not know precisely so a route can do this.
  const result = await handleContactIntent(form, {
    DB,
    user,
    HYPERAGENT_TRIGGER_URL: ctx.HYPERAGENT_TRIGGER_URL,
    HYPERAGENT_API_KEY: ctx.HYPERAGENT_API_KEY,
  });
  return result ?? { ok: false, error: "Unknown action." };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  return (
    <SettingsPage
      viewer={loaderData.viewer}
      email={loaderData.email}
      contacts={loaderData.contacts}
      unreadReplies={loaderData.unreadReplies}
      storedAccounts={loaderData.storedAccounts}
      unipile={loaderData.unipile}
    />
  );
}

// Re-exported so the page component can name the action's payload without
// importing a value out of a server module. Same hand-kept arrangement
// smartlead-page.tsx uses.
export type { AccountView };
