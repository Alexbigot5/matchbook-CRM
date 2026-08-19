// Server-only HTTP client for the Origami v2 API (https://docs.origami.chat).
//
// Same contract as app/lib/smartlead.server.ts and app/lib/hyperagent.server.ts,
// the other two outbound integrations: it NEVER throws, it returns a plain
// result object so callers can surface a friendly message, and an empty key
// means "integration disabled" rather than an attempted fetch. Everything that
// talks to Origami goes through here.
//
// WHAT THIS API IS. You hand an agent a plain-English brief; it researches and
// builds a TABLE; you read the rows back. Three objects matter:
//
//   POST /agents            -> 202, an agent plus an already-`running` run
//   POST /agents/{id}/runs  -> 202, a follow-up run on the same agent, which
//                              keeps its workspace and conversation
//   GET  /agents/{id}/runs/{runId} -> the run object; poll until terminal
//   GET  /tables/{id}/rows  -> what the agent built. Free.
//
// TWO THINGS THAT LOOK LIKE ERRORS BUT ARE NOT. First, a failed run is a 200:
// `errored`, `timed_out`, `step_cap_hit`, `incomplete`, `cancelled` and
// `needs_input` are all reported in `status`, not as HTTP status codes. A caller
// that only checks `ok` will read a dead run as a success. Second, `Retry-After`
// is present ONLY while a run is `running` — its absence is the documented
// signal to stop polling, so it is surfaced on the success path here, not just
// on 429s.
//
// NO RETRIES, for the reasons smartlead.server.ts sets out: every operation is
// resumable by polling again or pressing the button again, a blind sleep burns
// the Worker's wall-clock while a human waits, and the Idempotency-Key below
// makes a repeated POST safe. Retrying is what you do when re-running isn't.
//
// THE BUDGET THAT ACTUALLY BINDS. Origami rate-limits 100 requests per minute
// PER ORGANIZATION, shared by every key the org has issued, and the number of
// concurrent agent runs is plan-tunable down to ONE on starter. So the scarce
// thing is not our own throughput, it is the org's — which is why the polling
// cadence is enforced in D1 (prospect_runs.next_poll_at) rather than here, and
// why a 429 says CONCURRENT_LIMIT_EXCEEDED far more often than it says "slow
// down".
//
// The key travels in an Authorization header rather than a query parameter, so
// this module cannot make Smartlead's mistake of logging a live secret with
// `console.error(res.url)`. redact() is kept anyway: an error body we echo is
// still a string we did not write, and this value renders into the browser.

const ORIGAMI_BASE = "https://origami.chat/api/v2";

/** Per-request timeout. One hung call must not consume the whole invocation. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimum gap between calls from one client instance. Well inside the org's
 * documented 100/minute, while still letting one poll read three pages of rows
 * without feeling stalled.
 */
const MIN_GAP_MS = 200;

/** How much of an Origami error body to quote back. Enough to diagnose, not a payload. */
const MAX_ERROR_CHARS = 240;

/**
 * Fallback wait when a `running` run answers without a parseable Retry-After.
 * Matches the value Origami documents.
 */
export const DEFAULT_RETRY_AFTER_SECONDS = 15;

/** Rows per page. Their rows endpoint caps at 200; every other list caps at 100. */
export const ORIGAMI_ROW_PAGE = 200;

export type OrigamiResult<T> =
  | { ok: true; status: number; data: T; retryAfterSeconds?: number }
  | { ok: false; error: string; code?: string; status?: number; retryAfterSeconds?: number };

/** One entry of `response.actions[]` — the audit trail of what the agent changed. */
export type OrigamiAction = {
  type?: string;
  tableId?: string;
  tableName?: string;
  leadCount?: number;
};

/** One entry of `response.tables[]`, the same shape as GET /tables/{id}. */
export type OrigamiTable = {
  id?: string;
  name?: string;
  leadCount?: number;
  url?: string;
};

/** The run object, as returned by create, send, and every poll. */
export type OrigamiRun = {
  object?: string;
  id?: string;
  agentId?: string;
  status?: string;
  response?: {
    text?: string | null;
    actions?: OrigamiAction[];
    tables?: OrigamiTable[];
  } | null;
  todo?: {
    pendingQuestions?: unknown[];
    nextActions?: { label?: string; type?: string }[];
  } | null;
};

/**
 * POST /agents answers with the agent and its first run. The exact envelope is
 * read defensively — `createAgent` below accepts either a nested `{agent, run}`
 * or a flat run carrying an `agentId`, because the v2 API is documented as beta
 * and this is the one response whose shape we cannot re-request if it moves.
 */
export type OrigamiAgentCreated = {
  agent?: { id?: string };
  run?: OrigamiRun;
} & OrigamiRun;

/** One column of a table. `kind` is input | enrichment | score | sequence. */
export type OrigamiColumn = {
  name?: string;
  slug?: string;
  kind?: string;
};

/** A row with `cells=flat`: a plain { slug: value } bag rather than typed cells. */
export type OrigamiFlatRow = {
  object?: string;
  id?: string;
  cells?: Record<string, unknown>;
} & Record<string, unknown>;

/** The list envelope every list endpoint returns. */
export type OrigamiList<T> = {
  object?: string;
  items?: T[];
  nextCursor?: string | null;
  total?: number;
};

export type OrigamiClient = ReturnType<typeof createOrigamiClient>;

/**
 * Build a client bound to one API key, and optionally to one project.
 *
 * A factory rather than free functions taking a config, for the reason
 * smartlead.server.ts gives: the pacer state has to be shared across the several
 * calls one poll can make (a run check, a columns read, three pages of rows),
 * and it must stay per-request. A module-level pacer on Workers is per-isolate,
 * so it would throttle unrelated concurrent requests against each other while
 * doing nothing about a cold isolate.
 *
 * `projectId` scopes every request to a child org via the `x-origami-project`
 * header. Keys are parent-wide, so omitting it acts on the parent — which is the
 * right default for a single-tenant CRM.
 */
export function createOrigamiClient(apiKey: string, projectId = "") {
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

  /** Retry-After in seconds, or undefined when the header is absent or junk. */
  function retryAfter(res: Response): number | undefined {
    const raw = Number(res.headers.get("retry-after"));
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string | number>;
      /** Sent as Idempotency-Key. Origami replays the first response for 24h. */
      idempotencyKey?: string;
    } = {},
  ): Promise<OrigamiResult<T>> {
    if (!apiKey) {
      return { ok: false, error: "Origami is not configured." };
    }

    const url = new URL(ORIGAMI_BASE + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    await pace();

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(projectId ? { "x-origami-project": projectId } : {}),
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Includes the timeout abort. Redacted defensively — fetch implementations
      // have been known to quote the request URL, and one day someone will add a
      // query parameter here that shouldn't be quoted.
      const message = err instanceof Error ? err.message : "Failed to reach Origami.";
      return { ok: false, error: redact(message) };
    }

    // Read as text first rather than res.json(): a 204, an HTML error page from
    // a proxy, or a truncated body would all turn into a thrown SyntaxError, and
    // this module's whole contract is that it does not throw.
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      // Every Origami error is { error, code, details?, handoff? } with an
      // UPPERCASE_SNAKE_CASE code. The code is returned separately so the route
      // can map the ones a user can act on to its own sentences.
      let detail = text;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error || parsed?.message || text;
        if (typeof parsed?.code === "string") code = parsed.code;
      } catch {
        // keep the raw text
      }
      const trimmed = redact(String(detail ?? "")).slice(0, MAX_ERROR_CHARS).trim();
      return {
        ok: false,
        status: res.status,
        code,
        error: trimmed
          ? `Origami returned ${res.status}: ${trimmed}`
          : `Origami returned ${res.status}.`,
        retryAfterSeconds: retryAfter(res),
      };
    }

    // Retry-After is surfaced on the SUCCESS path too, because that is where it
    // does its real work: it is present only while a run is `running`, and its
    // absence is the documented signal to stop polling.
    const wait = retryAfter(res);

    if (!text.trim()) {
      return { ok: true, status: res.status, data: undefined as T, retryAfterSeconds: wait };
    }
    try {
      return {
        ok: true,
        status: res.status,
        data: JSON.parse(text) as T,
        retryAfterSeconds: wait,
      };
    } catch {
      return { ok: false, status: res.status, error: "Origami sent a response we couldn't read." };
    }
  }

  /**
   * Agent, run and table ids are interpolated into the URL *path*. They come
   * back from Origami rather than from a user, but they round-trip through D1 in
   * between, so they are re-checked here: a value like `x/../../account` or one
   * carrying a `?` re-points an authenticated request at a different endpoint,
   * and this module is the last place that can still tell. Same guard, same
   * reasoning, as safeId() in smartlead.server.ts — widened only to allow the
   * dots and colons a UUID-or-prefixed id can legitimately contain.
   */
  function safeId(id: string): string | null {
    return /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? id : null;
  }

  function badId<T>(what: string): OrigamiResult<T> {
    return { ok: false, error: `That Origami ${what} id isn’t valid.` };
  }

  return {
    /**
     * Create an agent and start its first run. Returns 202 with both ids; keep
     * them, because polling needs the pair.
     *
     * `model` is deliberately not sent: omitting it gets the best model the
     * plan unlocks, which is the right default and one less control on a panel
     * a salesperson uses.
     */
    createAgent(prompt: string, idempotencyKey: string) {
      return call<OrigamiAgentCreated>("POST", "/agents", {
        body: { prompt },
        idempotencyKey,
      });
    },

    /**
     * Send a follow-up run on an existing agent. This is how a `needs_input`
     * question gets answered and how a truncated run is continued — the agent
     * keeps its workspace and conversation, so the prompt can just say what's
     * next.
     */
    sendRun(agentId: string, prompt: string, idempotencyKey: string) {
      const safe = safeId(agentId);
      if (!safe) return Promise.resolve(badId<OrigamiRun>("agent"));
      return call<OrigamiRun>("POST", `/agents/${safe}/runs`, {
        body: { prompt },
        idempotencyKey,
      });
    },

    /** Poll one run. Check `retryAfterSeconds` on the result, not just `status`. */
    getRun(agentId: string, runId: string) {
      const safeAgent = safeId(agentId);
      if (!safeAgent) return Promise.resolve(badId<OrigamiRun>("agent"));
      const safeRun = safeId(runId);
      if (!safeRun) return Promise.resolve(badId<OrigamiRun>("run"));
      return call<OrigamiRun>("GET", `/agents/${safeAgent}/runs/${safeRun}`);
    },

    /** Stop the agent's current run. Whatever it built so far is kept. */
    cancelRun(agentId: string) {
      const safe = safeId(agentId);
      if (!safe) return Promise.resolve(badId<OrigamiRun>("agent"));
      return call<OrigamiRun>("POST", `/agents/${safe}/cancel`);
    },

    /**
     * The table's columns. Needed because an agent names its own columns — what
     * comes back is whatever it decided to build, so the slugs have to be
     * resolved onto our fields rather than assumed. See mapColumns() in
     * app/crm/prospecting.ts.
     */
    listColumns(tableId: string) {
      const safe = safeId(tableId);
      if (!safe) return Promise.resolve(badId<OrigamiList<OrigamiColumn>>("table"));
      return call<OrigamiList<OrigamiColumn>>("GET", `/tables/${safe}/columns`);
    },

    /**
     * One page of rows. Reads are free.
     *
     * `cells=flat` asks for the plain { slug: value } shape instead of the
     * polymorphic typed cells, which is all we need and far less to map.
     *
     * `defaults` IS DELIBERATELY NOT SENT, so the read inherits the table's
     * saved filters and sort — the view docs.origami.chat/reading-data describes
     * as "the same view you see in the Origami dashboard", and the flow their
     * fetch-the-data example follows.
     *
     * This used to pass `defaults=false`, reasoned as "the saved view is a
     * dashboard preference, and inheriting it would silently hide rows from a
     * table we just created". That reasoning is backwards for a table an AGENT
     * built. A hard requirement in the brief — "must have a work email", "only
     * companies still hiring" — is encoded by Origami as a default filter or
     * relevance condition ON the table, not as a second table. So the default
     * view IS the qualified deliverable, and bypassing it reads every candidate
     * ever added, in raw insertion order: a brief asking for ten people came
     * back with a hundred and fifty, and because only the filtered subset is
     * enriched, the panel's checklist read "0 verified · 0 likely · 150 no
     * match" for a run whose own summary said it had built a small table of
     * qualified contacts with verified emails.
     *
     * Don't reintroduce it without rereading docs.origami.chat/reading-data
     * first. If some future caller genuinely needs the unfiltered pool, that is
     * a separate parameter on this method, not a change to what every read does.
     */
    listRows(tableId: string, cursor?: string) {
      const safe = safeId(tableId);
      if (!safe) return Promise.resolve(badId<OrigamiList<OrigamiFlatRow>>("table"));
      return call<OrigamiList<OrigamiFlatRow>>("GET", `/tables/${safe}/rows`, {
        query: {
          cells: "flat",
          limit: ORIGAMI_ROW_PAGE,
          ...(cursor ? { cursor } : {}),
        },
      });
    },
  };
}
