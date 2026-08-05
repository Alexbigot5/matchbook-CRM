// Who is allowed to sign in, and what name their notes/touchpoints are authored
// under. This is the single source of truth for both questions.
//
// Deliberately isomorphic (no `.server` suffix, no server-only imports): the
// login route, the better-auth hooks, and the CRM UI all read from it. It holds
// no secrets — just four email addresses — so shipping it to the client is fine.
//
// Removing an email here revokes access on that person's next request, even if
// they still hold a valid session cookie, because requireUser() re-checks it.

export const ALLOWED_USERS: Record<string, string> = {
  "alexbigot5@gmail.com": "Alex",
  "tom@onmatchbook.com": "Tom",
  "britton@onmatchbook.com": "Britton",
  "mikehennesse@gmail.com": "Mike",
};

/**
 * better-auth lowercases emails on write, and users type inconsistently, so every
 * comparison in the codebase goes through this first.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowed(email: string): boolean {
  return normalizeEmail(email) in ALLOWED_USERS;
}

/** Display name for an allowlisted email, or "" if it isn't on the list. */
export function displayNameFor(email: string): string {
  return ALLOWED_USERS[normalizeEmail(email)] ?? "";
}
