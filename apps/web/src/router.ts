import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { RouterContext } from "./routes/__root.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
    ...(history ? { history } : {}),
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
