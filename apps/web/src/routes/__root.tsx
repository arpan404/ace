import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { AppShell } from "@/app/app-shell.tsx";
import { RootError, RouteNotFound } from "@/app/route-fallbacks.tsx";

export interface RouterContext {
  client: ClientApi;
  queryClient: QueryClient;
}

/** `?market=` opens the Marketplace modal over any page (features/marketplace/market-address.ts). */
const Search = z.object({
  market: z.catch(z.optional(z.string().check(z.maxLength(300))), undefined),
});

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Search,
  component: AppShell,
  notFoundComponent: RouteNotFound,
  errorComponent: RootError,
});
