import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { MarketSidebar, useMarketChanges } from "@/features/marketplace/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";

/** `?q=` is the panel's search and `?type=` its filter; every page under it keeps them. */
const Search = z.object({
  q: z.catch(z.optional(z.string().check(z.maxLength(200))), undefined),
  type: z.catch(
    z.optional(z.enum(["all", "suit", "spade-skill", "spade-plugin", "spade-bot", "spade"])),
    undefined,
  ),
});

export const Route = createFileRoute("/marketplace")({
  validateSearch: Search,
  component: Marketplace,
});

function Marketplace() {
  // Off in Settings › Beta, every marketplace address, deep links included, leads home.
  const on = useBetaEnabled("marketplace");
  if (on === false) return <Navigate to="/" replace />;
  if (on === undefined) return null;
  return <MarketplaceOn />;
}

function MarketplaceOn() {
  useMarketChanges();
  return (
    <ViewFrame label="Marketplace" sidebar={<MarketSidebar />} place="sidebar">
      <Outlet />
    </ViewFrame>
  );
}
