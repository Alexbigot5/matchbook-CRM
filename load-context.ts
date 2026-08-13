import { createContext, RouterContextProvider } from "react-router";
import { createAuth } from "./app/lib/auth.server";

// Secrets/vars for the HyperAgent integration and auth. HYPERAGENT_TRIGGER_URL
// and AUTH_EMAIL_FROM come from wrangler.toml [vars]; the keys are Worker secrets
// (`wrangler secret put ...`) mirrored in a local .dev.vars. They may be absent on
// the generated `Env` type until `wrangler types` runs, so read them through this
// shape.
type IntegrationEnv = {
  CRM_API_KEY?: string;
  HYPERAGENT_API_KEY?: string;
  HYPERAGENT_TRIGGER_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
  SMARTLEAD_API_KEY?: string;
};

export function getLoadContext(env: Env, request: Request) {
  const e = env as Env & IntegrationEnv;

  // Derive the auth base URL from the incoming request rather than pinning it to
  // a var, so `react-router dev` (:5173), `wrangler dev` (:8787) and production
  // are all correct with no per-environment config. It also makes the session
  // cookie's `secure` flag derive correctly (http://localhost → off, https → on),
  // and makes trustedOrigins self-configuring. BETTER_AUTH_URL overrides it for
  // the case where a proxy rewrites the host.
  const baseURL = e.BETTER_AUTH_URL || new URL(request.url).origin;

  let auth: ReturnType<typeof createAuth> | undefined;

  return {
    DB: env.DB,
    // Lazy so requests that never touch auth (/api/hyperagent, static assets)
    // don't pay to construct it.
    getAuth: () => (auth ??= createAuth(e as unknown as Parameters<typeof createAuth>[0], baseURL)),
    // Machine-to-machine config for HyperAgent (see app/routes/api.hyperagent.ts
    // and app/lib/hyperagent.server.ts). Default to "" so a missing binding is a
    // clean "disabled", not a crash.
    CRM_API_KEY: e.CRM_API_KEY ?? "",
    HYPERAGENT_API_KEY: e.HYPERAGENT_API_KEY ?? "",
    HYPERAGENT_TRIGGER_URL: e.HYPERAGENT_TRIGGER_URL ?? "",
    // Smartlead (app/lib/smartlead.server.ts). Same "" = disabled convention:
    // /smartlead renders and explains itself rather than erroring.
    SMARTLEAD_API_KEY: e.SMARTLEAD_API_KEY ?? "",
  };
}

export type LoadContext = ReturnType<typeof getLoadContext>;

// react-router 8's request handler takes a RouterContextProvider rather than
// a plain object, so route loaders/actions read values via `context.get(appContext)`.
export const appContext = createContext<LoadContext>();

export function createRouterContext(env: Env, request: Request) {
  const context = new RouterContextProvider();
  context.set(appContext, getLoadContext(env, request));
  return context;
}
