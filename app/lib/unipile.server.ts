// Server-only HTTP client for the Unipile REST API (v1).
//
// Same contract as app/lib/smartlead.server.ts and app/lib/hyperagent.server.ts,
// the other outbound integrations: it NEVER throws, it returns a plain result
// object so callers can surface a friendly message, and a missing key means
// "integration disabled" rather than an attempted fetch. Everything that talks
// to Unipile goes through here.
//
// TWO SETTINGS, NOT ONE. Unipile does not have a single global base URL: each
// customer is issued a DSN like `https://api8.unipile.com:13851`, and requests
// to the wrong one 404 rather than failing usefully. So the client needs the
// DSN as well as the key, and both are read from the load context. The DSN is
// not a credential — it is on every page of Unipile's dashboard — which is why
// it may live in wrangler.toml [vars] while the key must be a secret, exactly
// the split ORIGAMI_PROJECT_ID and ORIGAMI_API_KEY already make.
//
// THE KEY IS A HEADER (`X-API-KEY`), not a query parameter. That is the one way
// this integration is easier to hold than Smartlead's: the secret is never part
// of a URL, so logging a request URL is safe and no redact() is needed. Error
// BODIES are still truncated before they are returned, because an action's
// return value renders straight into the browser.
//
// NO RETRIES, for the reasons smartlead.server.ts sets out: every operation here
// is a button, a re-press is safe (the unique index on contact_replies is what
// guarantees it), and sleeping inside a Worker invocation burns wall-clock while
// a human waits on a fetcher. A 429 is reported with its Retry-After and stops.

/** Per-request timeout. One hung call must not consume the whole invocation. */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Minimum gap between calls from one client instance. Unipile's documented
 * ceiling is generous, but a full sync is one call per account plus one per
 * LinkedIn chat, so the pacer is what keeps a fifty-chat sync from arriving as a
 * burst. 120ms holds us near 8/s.
 */
const MIN_GAP_MS = 120;

/** How much of a Unipile error body to quote back. Enough to diagnose, not a payload. */
const MAX_ERROR_CHARS = 240;

export type UnipileResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: string; status?: number; retryAfterSeconds?: number };

/** Unipile's account object, narrowed to the fields this app reads. */
export type UnipileAccount = {
  id?: string;
  /** MAIL | GOOGLE_OAUTH | OUTLOOK | ICLOUD | LINKEDIN | WHATSAPP | … */
  type?: string;
  name?: string;
  created_at?: string;
  /**
   * Per-source connection health. A LinkedIn session whose cookie expired reports
   * `CREDENTIALS` here while the account itself still exists, which is the state
   * /settings has to be able to show — an account list alone would call it
   * connected.
   */
  sources?: { id?: string; status?: string }[];
};

export type UnipileAttendee = {
  id?: string;
  provider_id?: string;
  name?: string;
  is_self?: number | boolean;
  profile_url?: string;
  picture_url?: string;
};

/** One address on an email. Unipile calls the address field `identifier`. */
export type UnipileEmailAttendee = { display_name?: string; identifier?: string };

export type UnipileEmail = {
  id?: string;
  account_id?: string;
  date?: string;
  /** inbox | sent | archive | drafts | trash | spam | all | important | starred | unknown */
  role?: string;
  folders?: string[];
  subject?: string;
  from_attendee?: UnipileEmailAttendee;
  to_attendees?: UnipileEmailAttendee[];
  body_plain?: string;
  body?: string;
  thread_id?: string;
  message_id?: string;
  in_reply_to?: string;
};

export type UnipileChat = {
  id?: string;
  account_id?: string;
  account_type?: string;
  provider_id?: string;
  attendee_provider_id?: string;
  name?: string;
  unread_count?: number;
  timestamp?: string;
};

export type UnipileMessage = {
  id?: string;
  account_id?: string;
  chat_id?: string;
  sender_id?: string;
  sender_attendee_id?: string;
  text?: string | null;
  timestamp?: string;
  /** 1 when WE sent it. The whole point of a reply sync is the rows where this is 0. */
  is_sender?: number | boolean;
};

/** Every list endpoint answers with this envelope. `cursor` is null on the last page. */
export type UnipileList<T> = { object?: string; items?: T[]; cursor?: string | null };

export type UnipileClient = ReturnType<typeof createUnipileClient>;

/**
 * Normalise a DSN into an origin this client can build URLs against.
 *
 * Unipile's dashboard shows the DSN three ways depending on where you copy it
 * from — `api8.unipile.com:13851`, `https://api8.unipile.com:13851`, and the
 * same with a trailing `/api/v1`. All three are the same server and an operator
 * pasting any of them is not making a mistake, so all three are accepted here
 * rather than rejected with a format lecture on the settings page.
 *
 * Returns null for anything that isn't a plausible https origin. That check is
 * load-bearing rather than cosmetic: this value becomes the host every request
 * carrying the API key is sent to, so a DSN that is quietly wrong is a key
 * handed to a stranger. http:// is refused for the same reason.
 */
export function normalizeDsn(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return url.port ? `https://${url.hostname}:${url.port}` : `https://${url.hostname}`;
}

/**
 * Build a client bound to one key and one DSN.
 *
 * A factory rather than free functions taking a config, for the reason
 * createSmartleadClient documents: the pacer state has to be shared across the
 * dozens of calls one sync makes, and it must be per-request — a module-level
 * pacer on Workers is per-isolate, so it throttles unrelated concurrent requests
 * against each other while doing nothing about a cold isolate.
 */
export function createUnipileClient(apiKey: string, dsn: string) {
  const base = normalizeDsn(dsn);
  let nextSlot = 0;

  async function pace(): Promise<void> {
    const now = Date.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<UnipileResult<T>> {
    // The two halves of "configured" fail differently and an operator can only
    // fix what they are told about, so they are reported separately.
    if (!apiKey) return { ok: false, error: "Unipile isn’t configured: no API key." };
    if (!base) {
      return {
        ok: false,
        error: "Unipile isn’t configured: UNIPILE_DSN is missing or isn’t an https URL.",
      };
    }

    const url = new URL(base + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    await pace();

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          "X-API-KEY": apiKey,
          accept: "application/json",
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Includes the timeout abort.
      const message = err instanceof Error ? err.message : "Failed to reach Unipile.";
      return { ok: false, error: message.slice(0, MAX_ERROR_CHARS) };
    }

    const text = await res.text().catch(() => "");

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.detail || parsed?.message || parsed?.title || parsed?.error || text;
      } catch {
        // keep the raw text
      }
      const trimmed = String(detail ?? "").slice(0, MAX_ERROR_CHARS).trim();
      const result: UnipileResult<T> = {
        ok: false,
        status: res.status,
        error: trimmed
          ? `Unipile returned ${res.status}: ${trimmed}`
          : `Unipile returned ${res.status}.`,
      };
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        return {
          ...result,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
        };
      }
      return result;
    }

    if (!text.trim()) return { ok: true, status: res.status, data: undefined as T };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      // A 2xx we can't parse still means the write landed.
      return { ok: true, status: res.status, data: undefined as T };
    }
  }

  /**
   * Account and chat ids are interpolated into the URL *path*, so they are
   * re-checked here even where a validator already ran at the route edge.
   * Without this a value like `../../accounts` re-points an authenticated
   * request at a different endpoint — and this module is the last place that can
   * still tell. Same guard as smartlead.server.ts's safeId().
   */
  function safeId(id: string): string | null {
    return /^[A-Za-z0-9_=-]{1,128}$/.test(id) ? id : null;
  }

  function badId<T>(what: string): UnipileResult<T> {
    return { ok: false, error: `That ${what} id isn’t valid.` };
  }

  return {
    /** True when both halves of the configuration are present and usable. */
    configured: Boolean(apiKey && base),
    /** The normalised origin, for display on /settings. Never carries the key. */
    dsn: base,

    /* --- Accounts ------------------------------------------------------- *
     *
     * The connected mailboxes and LinkedIn sessions. Read live, never mirrored
     * into D1 — see migrations/0021 for why.
     */

    listAccounts(limit: number, cursor?: string) {
      return call<UnipileList<UnipileAccount>>("GET", "/api/v1/accounts", {
        query: { limit, cursor },
      });
    },

    /**
     * Disconnect an account at Unipile.
     *
     * This removes the connection, not the CRM's history: contact_replies rows
     * already synced from it stay, because a reply that happened is a fact about
     * the contact rather than about the mailbox that observed it.
     */
    deleteAccount(accountId: string) {
      const safe = safeId(accountId);
      if (!safe) return Promise.resolve(badId<unknown>("account"));
      return call<unknown>("DELETE", `/api/v1/accounts/${safe}`);
    },

    /* --- Hosted auth ---------------------------------------------------- *
     *
     * The "Connect" button. Unipile hosts the entire credential exchange —
     * Google's OAuth consent, LinkedIn's login and 2FA — on its own domain, so
     * no password or cookie ever reaches this Worker. That is the whole reason
     * to use it rather than POSTing credentials to /accounts ourselves.
     */

    /**
     * Mint a single-use hosted-auth URL to send the operator to.
     *
     * `expiresOn` must be exactly `YYYY-MM-DDTHH:MM:SS.sssZ` — Unipile validates
     * it against that pattern and rejects anything else, which is precisely what
     * `Date.prototype.toISOString()` produces.
     *
     * `api_url` is the DSN again, in the body. It is not redundant: it tells the
     * wizard which server to attach the new account to, and Unipile 400s without
     * it.
     */
    createHostedAuthLink(opts: {
      expiresOn: string;
      providers: string[] | "*";
      successRedirectUrl?: string;
      failureRedirectUrl?: string;
      name?: string;
    }) {
      return call<{ object?: string; url?: string }>("POST", "/api/v1/hosted/accounts/link", {
        body: {
          type: "create",
          api_url: base,
          expiresOn: opts.expiresOn,
          providers: opts.providers,
          // Single-use, because the URL is handed to a browser and browsers keep
          // history. A link that stays live is a link that connects a second,
          // unintended account to this workspace weeks later.
          single_use: true,
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.successRedirectUrl ? { success_redirect_url: opts.successRedirectUrl } : {}),
          ...(opts.failureRedirectUrl ? { failure_redirect_url: opts.failureRedirectUrl } : {}),
        },
      });
    },

    /* --- Email ---------------------------------------------------------- */

    /**
     * One page of a mailbox, newest first.
     *
     * `role: "inbox"` is what makes this a REPLY reader rather than a mail
     * reader: without it the same call returns everything the campaign sent, and
     * every one of those would match a contact and be logged as their reply.
     *
     * `after` is the watermark. Unipile treats it as exclusive, which is what
     * stops the last message of one sync being the first of the next.
     */
    listEmails(opts: { accountId: string; limit: number; after?: string; cursor?: string }) {
      return call<UnipileList<UnipileEmail>>("GET", "/api/v1/emails", {
        query: {
          account_id: opts.accountId,
          role: "inbox",
          limit: opts.limit,
          after: opts.after,
          cursor: opts.cursor,
        },
      });
    },

    /* --- LinkedIn ------------------------------------------------------- *
     *
     * Three calls rather than one, because LinkedIn messages carry no addressable
     * identity: a message has a `sender_attendee_id`, and only the chat's
     * attendee list turns that into a name and a profile URL a contact can be
     * matched on. So: messages since the watermark → the chats they belong to →
     * those chats' attendees.
     */

    listMessages(opts: { accountId: string; limit: number; after?: string; cursor?: string }) {
      return call<UnipileList<UnipileMessage>>("GET", "/api/v1/messages", {
        query: {
          account_id: opts.accountId,
          limit: opts.limit,
          after: opts.after,
          cursor: opts.cursor,
        },
      });
    },

    listChatAttendees(chatId: string) {
      const safe = safeId(chatId);
      if (!safe) return Promise.resolve(badId<UnipileList<UnipileAttendee>>("chat"));
      return call<UnipileList<UnipileAttendee>>("GET", `/api/v1/chats/${safe}/attendees`);
    },
  };
}
