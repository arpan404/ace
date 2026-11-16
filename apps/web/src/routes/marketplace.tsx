import { createFileRoute, Outlet } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { MarketSidebar, useMarketChanges } from "@/features/marketplace/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

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
  useMarketChanges();
  return (
    <ViewFrame label="Marketplace" sidebar={<MarketSidebar />} place="sidebar">
      <Outlet />
    </ViewFrame>
  );
}
