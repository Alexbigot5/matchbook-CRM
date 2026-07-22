import { createContext, RouterContextProvider } from "react-router";
import { createAuth } from "./app/lib/auth.server";

// Secrets/vars for the HyperAgent integration. HYPERAGENT_TRIGGER_URL comes
// from wrangler.toml [vars]; the two keys are Worker secrets (`wrangler secret
// put ...`) mirrored in a local .dev.vars. They may be absent on the generated
// `Env` type until `wrangler types` runs, so read them through this shape.
type IntegrationEnv = {
  CRM_API_KEY?: string;
  HYPERAGENT_API_KEY?: string;
  HYPERAGENT_TRIGGER_URL?: string;
};

export function getLoadContext(env: Env) {
  const e = env as Env & IntegrationEnv;
  return {
    DB: env.DB,
    auth: createAuth(env.DB),
    // Machine-to-machine config for HyperAgent (see app/routes/api.hyperagent.ts
    // and app/lib/hyperagent.server.ts). Default to "" so a missing binding is a
    // clean "disabled", not a crash.
    CRM_API_KEY: e.CRM_API_KEY ?? "",
    HYPERAGENT_API_KEY: e.HYPERAGENT_API_KEY ?? "",
    HYPERAGENT_TRIGGER_URL: e.HYPERAGENT_TRIGGER_URL ?? "",
  };
}

type LoadContext = ReturnType<typeof getLoadContext>;

// react-router 8's request handler takes a RouterContextProvider rather than
// a plain object, so route loaders/actions read values via `context.get(appContext)`.
export const appContext = createContext<LoadContext>();

export function createRouterContext(env: Env) {
  const context = new RouterContextProvider();
  context.set(appContext, getLoadContext(env));
  return context;
}
