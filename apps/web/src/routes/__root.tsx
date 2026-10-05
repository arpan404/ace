import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { AppShell } from "@/app/app-shell.tsx";
import { RootError, RouteNotFound } from "@/app/route-fallbacks.tsx";

export interface RouterContext {
  client: ClientApi;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: RouteNotFound,
  errorComponent: RootError,
});
