import { createContext, RouterContextProvider } from "react-router";
import { createAuth } from "./app/lib/auth.server";

export function getLoadContext(env: Env) {
  return {
    DB: env.DB,
    auth: createAuth(env.DB),
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
