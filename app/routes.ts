import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // Machine-callable JSON API for the HyperAgent integration (resource route).
  route("api/hyperagent", "routes/api.hyperagent.ts"),
] satisfies RouteConfig;
