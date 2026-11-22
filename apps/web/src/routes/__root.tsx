import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { RootLayout } from "@/app/root-layout.tsx";
import { RootError, RouteNotFound } from "@/app/route-fallbacks.tsx";

export interface RouterContext {
  client: ClientApi;
  queryClient: QueryClient;
}

/** `?store=` (and legacy `?market=`) opens the Store at that place (features/marketplace/market-address.ts). */
const Search = z.object({
  store: z.catch(z.optional(z.string().check(z.maxLength(300))), undefined),
  market: z.catch(z.optional(z.string().check(z.maxLength(300))), undefined),
});

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Search,
  component: RootLayout,
  notFoundComponent: RouteNotFound,
  errorComponent: RootError,
});
