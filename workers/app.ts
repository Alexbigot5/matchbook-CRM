import { createRequestHandler } from "react-router";
import { createRouterContext } from "../load-context";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    return requestHandler(request, createRouterContext(env));
  },
} satisfies ExportedHandler<Env>;
