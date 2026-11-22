import { createFileRoute, Navigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/**
 * Legacy `/market` route: redirects to `/store` keeping `?at=…` so existing links keep working.
 * Off in Settings › Beta, it goes home.
 */
export const Route = createFileRoute("/market")({
  validateSearch: z.object({
    at: z.catch(z.optional(z.string().check(z.maxLength(300))), undefined),
  }),
  component: MarketRedirect,
});

function MarketRedirect() {
  const { at } = Route.useSearch();
  const on = useBetaEnabled("marketplace");
  if (on === false) return <Navigate to="/" replace />;
  return <Navigate to="/store" search={at ? { at } : {}} replace />;
}
