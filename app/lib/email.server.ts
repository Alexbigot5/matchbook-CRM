// Transactional email via Resend's REST API.
//
// Uses plain `fetch` rather than the `resend` SDK: this is a single POST, and the
// SDK drags in React-email rendering paths that would grow the Workers bundle for
// no benefit. The tradeoff is that the payload shape is maintained by hand.

export type EmailEnv = {
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Matchbook CRM <noreply@onmatchbook.com>";

/** Minimal HTML escape — the URL is server-generated, but the habit is free. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(url: string, minutes: number): string {
  const safe = esc(url);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1a;">
    <div style="max-width:420px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e1;border-radius:14px;padding:28px;">
      <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#8a8a84;">Matchbook CRM</div>
      <h1 style="font-size:19px;font-weight:600;margin:14px 0 6px;">Sign in</h1>
      <p style="font-size:14px;line-height:1.55;color:#57575a;margin:0 0 22px;">
        Click the button below to sign in. This link expires in ${minutes} minutes and can only be used once.
      </p>
      <a href="${safe}" style="display:block;text-align:center;background:#111111;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:9px;font-size:14px;font-weight:500;">Sign in to Matchbook CRM</a>
      <p style="font-size:12px;line-height:1.55;color:#8a8a84;margin:22px 0 0;">
        If the button doesn't work, paste this into your browser:<br />
        <span style="word-break:break-all;color:#57575a;">${safe}</span>
      </p>
      <p style="font-size:12px;line-height:1.55;color:#8a8a84;margin:16px 0 0;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * Send the magic-link email. Throws on any non-2xx so a misconfigured sender
 * domain surfaces loudly in `wrangler tail` (and as an error on the login page)
 * instead of silently pretending the mail was delivered.
 */
export async function sendSignInEmail(
  env: EmailEnv,
  to: string,
  url: string,
  expiresInSeconds: number,
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set — cannot send the sign-in email.");
  }

  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM || DEFAULT_FROM,
      to: [to],
      subject: "Your Matchbook CRM sign-in link",
      text: `Sign in to Matchbook CRM:\n\n${url}\n\nThis link expires in ${minutes} minutes and can only be used once.\nIf you didn't request this, you can safely ignore this email.`,
      html: buildHtml(url, minutes),
    }),
  });

  if (!res.ok) {
    // Resend puts the actionable reason (unverified domain, bad key) in the body.
    throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
  }
}
