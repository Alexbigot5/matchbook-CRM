// Durable fixed-window rate limiting backed by D1.
//
// Why not an in-memory counter: on Workers a module-level Map is per-isolate and
// evicted constantly, so it does not meaningfully limit anything. (That is also
// why better-auth's default `storage: "memory"` limiter is ineffective here, and
// why auth.server.ts switches it to "database".) D1 is the only store shared
// across isolates that this app already has.
//
// Fixed windows rather than a sliding log: one row per key for all time, one
// round trip per check, and the worst case — 2x the limit across a window
// boundary — is irrelevant at the thresholds used here.

const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export type RateLimitResult = {
  allowed: boolean;
  /** Requests remaining in the current window (0 once blocked). */
  remaining: number;
  /** Seconds until the current window ends — suitable for a Retry-After header. */
  retryAfterSeconds: number;
};

export type RateLimitRule = {
  /** Namespace, so two rules can't collide on the same subject. */
  bucket: string;
  limit: number;
  windowMs: number;
};

/**
 * Count this request against `rule` for `subject` and report whether it may
 * proceed.
 *
 * **Fails open.** If D1 is unavailable this returns `allowed: true` rather than
 * locking every user out of sign-in over a transient database error. That is the
 * right trade for a limiter — it is a availability control, not an authorization
 * control, and the actual gate (allowlist, bearer token) is unaffected either
 * way. The failure is logged so it surfaces in `wrangler tail`.
 */
export async function rateLimit(
  db: D1Database,
  rule: RateLimitRule,
  subject: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const key = `${rule.bucket}:${subject}`;
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart + rule.windowMs - now) / 1000),
  );

  try {
    // Upsert and read the resulting count in one statement. When the stored row
    // belongs to an older window we reset to 1 instead of incrementing, which is
    // what makes a single row serve a key indefinitely.
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
           window_start = ?2
         RETURNING count`,
      )
      .bind(key, windowStart)
      .first<{ count: number }>();

    const count = row?.count ?? 1;

    // A count of 1 means this call opened a new window for the key — an
    // infrequent moment, so it's a cheap place to hang the cleanup of keys that
    // were seen once and never again.
    if (count === 1) {
      await db
        .prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(now - PRUNE_AFTER_MS)
        .run();
    }

    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds,
    };
  } catch (err) {
    console.error("[ratelimit] check failed, allowing request:", err);
    return { allowed: true, remaining: rule.limit, retryAfterSeconds };
  }
}

/**
 * Best-effort client identifier. `CF-Connecting-IP` is set by Cloudflare's edge
 * and cannot be spoofed by the client on a real deployment; the fallbacks only
 * matter for local dev. Everything collapsing to "unknown" locally is fine — it
 * makes the limiter stricter, never weaker.
 */
export function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// --- Rules -----------------------------------------------------------------

/**
 * Sign-in requests per IP. The form posts to the /login action, which calls
 * better-auth's server API directly and therefore bypasses the library's own
 * limiter entirely — without this, sending magic links is unmetered.
 */
export const LOGIN_IP_RULE: RateLimitRule = {
  bucket: "login:ip",
  limit: 10,
  windowMs: 10 * 60 * 1000,
};

/**
 * Sign-in requests per target address, so a distributed caller can't mail-bomb
 * one inbox from many IPs. Four users signing in legitimately will never see
 * five links in ten minutes.
 */
export const LOGIN_EMAIL_RULE: RateLimitRule = {
  bucket: "login:email",
  limit: 5,
  windowMs: 10 * 60 * 1000,
};

/**
 * Machine API requests per IP. Generous enough for real automation, low enough
 * that brute-forcing a bearer token is hopeless — and the GET returns the whole
 * contact database, so unmetered access to it is the worst case in the app.
 */
export const API_RULE: RateLimitRule = {
  bucket: "api:ip",
  limit: 120,
  windowMs: 60 * 1000,
};

/** Failed bearer-token attempts per IP, over a long window. */
export const API_AUTH_FAIL_RULE: RateLimitRule = {
  bucket: "api:authfail",
  limit: 10,
  windowMs: 15 * 60 * 1000,
};

/**
 * Smartlead writes per signed-in user.
 *
 * The only session-gated page that gets a limiter, and it earns one: a single
 * click there fans out to a dozen calls against a metered third-party API and can
 * put hundreds of contacts into a live sending campaign. A stuck client
 * re-submitting is how a Smartlead quota gets burned and people get mailed twice.
 * Keyed on the user's email rather than the IP, because four people behind one
 * office address shouldn't share a budget.
 *
 * Generous enough that no real session notices — twenty deliberate button presses
 * in a minute is already someone hammering.
 */
export const SMARTLEAD_RULE: RateLimitRule = {
  bucket: "smartlead:user",
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Sequence-builder edits per signed-in user.
 *
 * A separate, much looser bucket because these intents reach nothing but D1:
 * adding, reordering, retiming and removing steps is local editing, and the
 * reasoning above — a metered API, real email going out — applies to none of it.
 * Arranging a ten-step sequence is easily twenty writes in a minute, so metering
 * it against the push budget would lock someone out of a text editor to protect
 * a quota it cannot spend.
 *
 * Still bounded rather than exempt: it is a write path on a shared dataset, and
 * "nothing unbounded" is the rule this file exists to keep.
 */
export const SMARTLEAD_BUILDER_RULE: RateLimitRule = {
  bucket: "smartlead:builder",
  limit: 240,
  windowMs: 60 * 1000,
};
