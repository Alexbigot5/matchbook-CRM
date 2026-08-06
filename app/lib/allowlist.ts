// Who is allowed to sign in, and what name their notes/touchpoints are authored
// under. This is the single source of truth for both questions.
//
// Deliberately isomorphic (no `.server` suffix, no server-only imports): the
// login route, the better-auth hooks, and the CRM UI all read from it. It holds
// no secrets — just four email addresses — so shipping it to the client is fine.
//
// Removing an email here revokes access on that person's next request, even if
// they still hold a valid session cookie, because requireUser() re-checks it.

// Null-prototype so the map carries nothing but these four keys. With a plain
// object literal, `"constructor" in ALLOWED_USERS` and `ALLOWED_USERS["__proto__"]`
// both hit Object.prototype — see the note on isAllowed below.
export const ALLOWED_USERS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    "alexbigot5@gmail.com": "Alex",
    "tom@onmatchbook.com": "Tom",
    "britton@onmatchbook.com": "Britton",
    "mikehennesse@gmail.com": "Mike",
  },
);

/**
 * better-auth lowercases emails on write, and users type inconsistently, so every
 * comparison in the codebase goes through this first.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `Object.hasOwn`, not the `in` operator: `in` walks the prototype chain, and
 * `Object.prototype` has all-lowercase members that survive normalizeEmail — so
 * `isAllowed("constructor")` and `isAllowed("__proto__")` both returned true.
 * Nothing could reach this with such a value today (better-auth validates the
 * body as an email first), but this is the function the whole gate rests on, so
 * it should be correct on its own terms rather than by upstream accident.
 */
export function isAllowed(email: string): boolean {
  return Object.hasOwn(ALLOWED_USERS, normalizeEmail(email));
}

/** Display name for an allowlisted email, or "" if it isn't on the list. */
export function displayNameFor(email: string): string {
  const key = normalizeEmail(email);
  return Object.hasOwn(ALLOWED_USERS, key) ? ALLOWED_USERS[key] : "";
}
