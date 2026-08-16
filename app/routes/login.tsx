import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { appContext } from "../../load-context";
import { Box, css } from "../crm/ui";
import { isAllowed, normalizeEmail } from "../lib/allowlist";
import { getOptionalUser } from "../lib/session.server";
import {
  clientKey,
  rateLimit,
  LOGIN_EMAIL_RULE,
  LOGIN_IP_RULE,
} from "../lib/ratelimit.server";
// Server-only: referenced from the action, which React Router strips from the
// client build. Never reference this from the component below.
import { MAGIC_LINK_TTL_SECONDS } from "../lib/auth.server";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sign in · Matchbook CRM" },
    { name: "robots", content: "noindex" },
  ];
}

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700&display=swap",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = context.get(appContext);
  // Already signed in — nothing to do here.
  if (await getOptionalUser(request, ctx)) throw redirect("/");
  return null;
}

// `expiresInMinutes` is serialized out of the action rather than imported from
// auth.server.ts: the component renders it, and component code ships to the
// browser, so importing the server module there would pull better-auth into the
// client bundle.
type ActionResult =
  | { sent: true; email: string; expiresInMinutes: number }
  | { sent: false; error: string };

/**
 * Same-origin check for this action.
 *
 * The sign-in form is a cookie-less POST, so SameSite gives it no protection at
 * all: any site can post here and cause a real magic link to be emailed. This is
 * the CSRF defence for the /login route specifically. Requests with no Origin
 * and no Referer (curl, some older clients) are allowed through — the rate
 * limits below bound what that permits.
 */
function isSameOrigin(request: Request): boolean {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expected;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * better-auth validates `callbackURL` again when the link is *redeemed*, using a
 * stricter pattern than a `startsWith("/")` check. Matching it here means a bad
 * value is rejected at submit time with a readable message, rather than emailing
 * a link that dead-ends on `403 INVALID_CALLBACK_URL` when clicked.
 *
 * The previous check also missed `/\evil.com`, which browsers normalize to a
 * protocol-relative `//evil.com`.
 */
const SAFE_NEXT_RE = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/i;

function safeNext(raw: string): string {
  return SAFE_NEXT_RE.test(raw) ? raw : "/";
}

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const ctx = context.get(appContext);

  if (!isSameOrigin(request)) {
    return { sent: false, error: "Request blocked. Please sign in from the app itself." };
  }

  const form = await request.formData();
  const email = normalizeEmail(form.get("email")?.toString() ?? "");

  if (!email) return { sent: false, error: "Enter your email address." };

  // Layer 1 of the allowlist: reject before better-auth is involved at all, so a
  // non-allowlisted address never reaches Resend and never creates a user row.
  if (!isAllowed(email)) {
    return { sent: false, error: "This email address isn't authorized for Matchbook CRM." };
  }

  // Metered here rather than by better-auth: this action calls the server API
  // directly, and the library's limiter (like its CSRF middleware) lives in the
  // HTTP handler path we bypass. Both an IP limit and a per-address limit, so
  // neither one IP nor one distributed campaign can flood a single inbox.
  const tooManyFromIp = await rateLimit(ctx.DB, LOGIN_IP_RULE, clientKey(request));
  if (!tooManyFromIp.allowed) {
    return { sent: false, error: "Too many sign-in attempts. Try again in a few minutes." };
  }
  const tooManyForEmail = await rateLimit(ctx.DB, LOGIN_EMAIL_RULE, email);
  if (!tooManyForEmail.allowed) {
    return { sent: false, error: "Too many sign-in links requested for that address. Try again shortly." };
  }

  // `next` lets the magic link land back on the page the user originally wanted.
  // Constrained to a same-site path so it can't be used as an open redirect.
  const next = safeNext(form.get("next")?.toString() ?? "/");

  try {
    // `request` is passed, not just its headers: better-auth's origin check and
    // CSRF middleware both short-circuit on `if (!ctx.request) return`, so
    // omitting it silently disabled them.
    await ctx.getAuth().api.signInMagicLink({
      body: { email, callbackURL: next, errorCallbackURL: "/login" },
      headers: request.headers,
      request,
    });
  } catch (err) {
    // Most likely an unverified Resend sender domain or a missing API key — the
    // real cause is logged for `wrangler tail`, not shown to the user.
    console.error("[login] failed to send magic link:", err);
    return { sent: false, error: "Couldn't send the sign-in email. Try again in a moment." };
  }

  return {
    sent: true,
    email,
    expiresInMinutes: Math.round(MAGIC_LINK_TTL_SECONDS / 60),
  };
}

// Error codes better-auth's magic-link verify endpoint redirects back with.
const ERROR_COPY: Record<string, string> = {
  INVALID_TOKEN: "That sign-in link has expired or was already used. Request a new one.",
  new_user_signup_disabled: "This email address isn't authorized for Matchbook CRM.",
  failed_to_create_user: "This email address isn't authorized for Matchbook CRM.",
  failed_to_create_session: "Something went wrong signing you in. Try again.",
};

const PAGE = "min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#f7f7f5; font-family:'Geist', system-ui, sans-serif; color:#1a1a1a; -webkit-font-smoothing:antialiased; padding:24px;";
const CARD = "width:100%; max-width:340px; background:#ffffff; border:1px solid #ededea; border-radius:12px; padding:26px 24px; box-shadow:0 1px 2px rgba(0,0,0,0.04);";
const LABEL = "font-size:11px; font-weight:500; color:#9a9a95; text-transform:uppercase; letter-spacing:0.05em; display:block; margin-bottom:7px;";
const INPUT = "width:100%; height:38px; padding:0 11px; border:1px solid #e2e2de; border-radius:8px; font-size:13.5px; font-family:inherit; color:#1a1a1a; outline:none; background:#fff;";
const BUTTON = "width:100%; height:40px; margin-top:16px; background:#1a1a1a; color:#ffffff; border:none; border-radius:8px; font-size:13.5px; font-weight:500; font-family:inherit; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:7px;";

export default function Login({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const sending = navigation.state === "submitting";

  const next = params.get("next") ?? "/";
  const urlError = params.get("error");
  // Object.hasOwn, not a bare index: `?error=constructor` would otherwise
  // resolve through the prototype chain to a function and get rendered as a
  // React child.
  const errorCopy =
    urlError && Object.hasOwn(ERROR_COPY, urlError) ? ERROR_COPY[urlError] : null;
  const error =
    (actionData && !actionData.sent ? actionData.error : null) ??
    (urlError ? errorCopy ?? "Something went wrong signing you in. Try again." : null);

  const sent = actionData?.sent ? actionData : null;

  return (
    <div style={css(PAGE)}>
      <div style={css("font-size:13px; font-weight:600; letter-spacing:-0.01em; margin-bottom:14px;")}>
        Matchbook CRM
      </div>

      <div style={css(CARD)}>
        {sent ? (
          <>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>Check your email</div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:6px; line-height:1.5;")}>
              We sent a sign-in link to <span style={css("color:#57575a;")}>{sent.email}</span>. It expires in{" "}
              {sent.expiresInMinutes} minutes and can only be used once.
            </div>
            <Form method="get" action="/login">
              {next !== "/" && <input type="hidden" name="next" value={next} />}
              <Box
                as="button"
                type="submit"
                style={css(BUTTON + "background:#ffffff; color:#57575a; border:1px solid #e2e2de;")}
                hover={css("background:#f7f7f5;")}
              >
                Use a different email
              </Box>
            </Form>
          </>
        ) : (
          <>
            <div style={css("font-size:17px; font-weight:600; letter-spacing:-0.015em;")}>Sign in</div>
            <div style={css("font-size:12.5px; color:#9a9a95; margin-top:6px; line-height:1.5;")}>
              Enter your work email and we'll send a sign-in link.
            </div>

            <Form method="post" style={css("margin-top:18px;")}>
              <input type="hidden" name="next" value={next} />
              <label htmlFor="email" style={css(LABEL)}>Email</label>
              <Box
                as="input"
                id="email"
                name="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                spellCheck={false}
                placeholder="you@company.com"
                style={css(INPUT)}
                focus={css("border-color:#1a1a1a;")}
              />

              {error && (
                <div
                  role="alert"
                  style={css("margin-top:10px; font-size:12px; line-height:1.45; color:#9a5b5b; background:#f4ecec; border:1px solid #ecdada; border-radius:7px; padding:8px 10px;")}
                >
                  {error}
                </div>
              )}

              <Box
                as="button"
                type="submit"
                disabled={sending}
                style={css(BUTTON + (sending ? "opacity:0.65; cursor:default;" : ""))}
                hover={sending ? undefined : css("background:#000000;")}
              >
                {sending ? "Sending…" : "Continue"}
                {!sending && <span aria-hidden="true">→</span>}
              </Box>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
