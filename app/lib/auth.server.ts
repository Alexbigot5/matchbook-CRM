import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";

export function createAuth(db: D1Database) {
  return betterAuth({
    database: new D1Dialect({ database: db }),
    emailAndPassword: { enabled: true },
    session: {
      cookieCache: { enabled: true }
    }
  });
}
