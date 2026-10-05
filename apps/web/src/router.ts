import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { RouteError, RouteNotFound } from "./app/route-fallbacks.tsx";
import type { RouterContext } from "./routes/__root.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    // Inside the shell: an unknown address or a failing route keeps the header and sidebar.
    defaultNotFoundComponent: RouteNotFound,
    defaultErrorComponent: RouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
