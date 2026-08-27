// Server-only HTTP client for the Smartlead.ai REST API (v1).
//
// Same contract as app/lib/hyperagent.server.ts, the other outbound integration:
// it NEVER throws, it returns a plain result object so callers can surface a
// friendly message, and an empty key means "integration disabled" rather than an
// attempted fetch. Everything that talks to Smartlead goes through here.
//
// THE API KEY IS A QUERY PARAMETER. Smartlead has no bearer-token auth — every
// request carries `?api_key=…`, so the live secret is part of every request URL.
// That makes two ordinary habits dangerous:
//
//   * `console.error(res.url)` writes the key to the Worker log.
//   * echoing a Smartlead error body can echo the key, and an action's return
//     value renders straight into the browser.
//
// So every string this module returns or logs passes through redact() first. A
// bearer-header integration cannot make this mistake; this one can, which is why
// the redaction is a named function rather than a comment.
//
// NO RETRIES. A 429 is reported with its Retry-After and the call stops. Three
// reasons: the pacer below makes self-inflicted 429s unlikely, so a 429 means
// someone else is using the key and sleeping inside this invocation won't help;
// a blind sleep burns the Worker's wall-clock while a human waits on a fetcher;
// and every operation here is designed to be resumable by clicking the button
// again — the unique index on smartlead_leads guarantees a re-click can't
// double-send. Retrying is what you do when re-running is unsafe. Here it isn't.

const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";

/** Per-request timeout. One hung call must not consume the whole invocation. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimum gap between calls from one client instance. Smartlead's documented
 * ceiling is around 10 requests per 2 seconds; 250ms holds us near 4/s, which is
 * comfortably under it while still finishing a ten-chunk lead push in ~3s.
 */
const MIN_GAP_MS = 250;

/** How much of a Smartlead error body to quote back. Enough to diagnose, not a payload. */
const MAX_ERROR_CHARS = 240;

export type SmartleadResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: string; status?: number; retryAfterSeconds?: number };

/** Values Smartlead accepts as campaign status INPUT. See validate.ts's whitelist. */
export type SmartleadStatusInput = "START" | "PAUSED" | "STOPPED";

export type SmartleadCampaignRow = {
  id?: number | string;
  name?: string;
  status?: string;
};

export type SmartleadSchedule = {
  timezone: string;
  days_of_the_week: number[];
  start_hour: string;
  end_hour: string;
  min_time_btw_emails: number;
  max_new_leads_per_day: number;
  schedule_start_time?: string;
};

/**
 * Normalise the campaign status Smartlead REPORTS into the value it ACCEPTS.
 *
 * Smartlead returns ACTIVE for a running campaign but only accepts START to make
 * one run. Posting a status straight back from a read is therefore a 400 — and
 * the failure mode is nasty, because the obvious use is "pause, edit, restore",
 * where a failed restore leaves a live campaign silently paused.
 *
 * Returns null for states that must not be restored: a STOPPED or COMPLETED
 * campaign was deliberately ended, and DRAFTED never ran.
 */
export function toStatusInput(observed: string | undefined | null): SmartleadStatusInput | null {
  const s = (observed ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "START" || s === "RUNNING") return "START";
  if (s === "PAUSED") return "PAUSED";
  return null;
}

/** True when Smartlead considers the campaign to be sending right now. */
export function isCampaignLive(observed: string | undefined | null): boolean {
  return toStatusInput(observed) === "START";
}

export type SmartleadClient = ReturnType<typeof createSmartleadClient>;

/**
 * Build a client bound to one API key.
 *
 * A factory rather than free functions taking a config, because the pacer state
 * has to be shared across the dozen-odd calls a single button press makes. It is
 * per-instance, and therefore per-request: a module-level pacer on Workers is
 * per-isolate, so it would throttle unrelated concurrent requests against each
 * other while doing nothing about a cold isolate.
 */
export function createSmartleadClient(apiKey: string) {
  let nextSlot = 0;

  /** Replace the live key wherever it appears, before anything is returned or logged. */
  function redact(text: string): string {
    if (!apiKey) return text;
    return text.split(apiKey).join("***");
  }

  async function pace(): Promise<void> {
    const now = Date.now();
    const wait = nextSlot - now;
    nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number> } = {},
  ): Promise<SmartleadResult<T>> {
    if (!apiKey) {
      return { ok: false, error: "Smartlead is not configured." };
    }

    const url = new URL(SMARTLEAD_BASE + path);
    url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    await pace();

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: opts.body === undefined ? {} : { "content-type": "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Includes the timeout abort. The message is redacted defensively — fetch
      // implementations have been known to quote the request URL.
      const message = err instanceof Error ? err.message : "Failed to reach Smartlead.";
      return { ok: false, error: redact(message) };
    }

    // Never res.json(): several Smartlead write endpoints answer with plain
    // "success" despite documenting JSON, and an unguarded parse turns a
    // successful write into a thrown SyntaxError.
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.message || parsed?.error || parsed?.err || text;
      } catch {
        // keep the raw text
      }
      const trimmed = redact(String(detail ?? "")).slice(0, MAX_ERROR_CHARS).trim();
      const result: SmartleadResult<T> = {
        ok: false,
        status: res.status,
        error: trimmed
          ? `Smartlead returned ${res.status}: ${trimmed}`
          : `Smartlead returned ${res.status}.`,
      };
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        return {
          ...result,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2,
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
   * Campaign ids are interpolated into the URL *path*, so they are re-checked
   * here even though validateCampaignId() already ran at the route edge. Without
   * this, a value like `1?api_key=…&` or `../../` re-points an authenticated
   * request at a different endpoint — and this module is the last place that can
   * still tell.
   */
  function safeId(id: string): string | null {
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  }

  function badId<T>(): SmartleadResult<T> {
    return { ok: false, error: "That campaign id isn’t valid." };
  }

  /**
   * Email account ids travel in the request BODY, not the path, so they cannot
   * re-point the URL the way safeId() guards against. They are checked anyway:
   * `email_account_ids` is the field that decides which mailboxes a campaign
   * sends from, and a value this module can’t recognise as an id is one it has
   * no business posting under a live key. Smartlead wants numbers there, so the
   * check and the coercion are the same step.
   */
  function safeAccountId(id: string): number | null {
    return /^\d{1,19}$/.test(id) ? Number(id) : null;
  }

  function badAccountId<T>(): SmartleadResult<T> {
    return { ok: false, error: "That mailbox id isn’t valid." };
  }

  return {
    listCampaigns() {
      return call<SmartleadCampaignRow[]>("GET", "/campaigns/");
    },

    createCampaign(name: string) {
      return call<{ id?: number | string; campaign_id?: number | string }>(
        "POST",
        "/campaigns/create",
        { body: { name } },
      );
    },

    setCampaignStatus(id: string, status: SmartleadStatusInput) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      return call<unknown>("POST", `/campaigns/${safe}/status`, { body: { status } });
    },

    setSchedule(id: string, schedule: SmartleadSchedule) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      return call<unknown>("POST", `/campaigns/${safe}/schedule`, { body: schedule });
    },

    /**
     * Replace the campaign's entire sequence. The campaign must be PAUSED first —
     * Smartlead refuses the edit while it is ACTIVE, with an opaque 400. Only
     * pushSequence in the route may call this; it owns the pause/restore dance.
     */
    saveSequences(id: string, sequences: unknown[]) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      return call<unknown>("POST", `/campaigns/${safe}/sequences`, { body: { sequences } });
    },

    /** One chunk only, capped by the caller at SMARTLEAD_LEAD_CHUNK. */
    addLeads(id: string, leadList: unknown[]) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      return call<Record<string, unknown>>("POST", `/campaigns/${safe}/leads`, {
        // No ignore_* flags. Overriding a global block list or an unsubscribe
        // list is the one thing here that turns a CRM bug into a legal problem,
        // so those defaults are left exactly where Smartlead put them.
        body: { lead_list: leadList },
      });
    },

    listLeads(id: string, offset: number, limit: number) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<Record<string, unknown>>());
      return call<Record<string, unknown>>("GET", `/campaigns/${safe}/leads`, {
        query: { offset, limit },
      });
    },

    getAnalytics(id: string) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<Record<string, unknown>>());
      return call<Record<string, unknown>>("GET", `/campaigns/${safe}/analytics`);
    },

    listStatistics(id: string, offset: number, limit: number) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<Record<string, unknown>>());
      return call<Record<string, unknown>>("GET", `/campaigns/${safe}/statistics`, {
        query: { offset, limit },
      });
    },

    /* --- Email accounts (the mailboxes a campaign sends from) ------------ *
     *
     * Read-and-assign only. Nothing here buys, creates or reconnects a mailbox:
     * the same rule the rest of this page follows, where the campaign, the leads
     * and the templates all exist upstream and the CRM only points at them.
     *
     * The responses are typed `unknown` rather than a row shape, for the reason
     * listLeads is: Smartlead answers with a bare array on some accounts and an
     * envelope on others, so the caller unwraps through rowsOf() and maps
     * through planSenders() instead of indexing what came back.
     */

    /** The mailboxes currently assigned to one campaign. */
    listCampaignEmailAccounts(id: string) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      return call<unknown>("GET", `/campaigns/${safe}/email-accounts`);
    },

    /** One page of every mailbox on the Smartlead account. */
    listEmailAccounts(offset: number, limit: number) {
      return call<unknown>("GET", "/email-accounts/", { query: { offset, limit } });
    },

    /**
     * Add one existing mailbox to the campaign’s sending rotation.
     *
     * Smartlead takes a list here; this sends one id at a time deliberately, so
     * a rejected mailbox is reported as that mailbox rather than as a partial
     * batch nobody can tell the shape of.
     */
    assignEmailAccountToCampaign(id: string, accountId: string) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      const account = safeAccountId(accountId);
      if (account === null) return Promise.resolve(badAccountId<unknown>());
      return call<unknown>("POST", `/campaigns/${safe}/email-accounts`, {
        body: { email_account_ids: [account] },
      });
    },

    /**
     * Take one mailbox out of the campaign’s rotation.
     *
     * This unassigns; it does not delete the mailbox or touch its warmup. The
     * account keeps it, and any other campaign using it is unaffected.
     */
    removeEmailAccountFromCampaign(id: string, accountId: string) {
      const safe = safeId(id);
      if (!safe) return Promise.resolve(badId<unknown>());
      const account = safeAccountId(accountId);
      if (account === null) return Promise.resolve(badAccountId<unknown>());
      return call<unknown>("DELETE", `/campaigns/${safe}/email-accounts`, {
        body: { email_account_ids: [account] },
      });
    },
  };
}
