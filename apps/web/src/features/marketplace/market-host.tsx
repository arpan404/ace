import { StorefrontIcon } from "@ace/icons";
import { Navigate, useRouterState } from "@tanstack/react-router";
import { Icon } from "@/components/icon.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useOpenMarket } from "@/lib/open-market.ts";

/*
 * The Marketplace is a page (`/market`). A `?market=` on any other page, as links and the
 * "open in ace" deep link carry, opens that page at the same place, in place of the one it was on.
 */

/** The `?market=` value on the address, if any. */
function useMarketParam(): string | undefined {
  return useRouterState({ select: (state) => state.location.search.market });
}

/** Sends `?market=…` on any page to the Marketplace's page at that place. */
export function MarketHost() {
  // Off in Settings › Beta, no address opens it, deep links included.
  const on = useBetaEnabled("marketplace") === true;
  const value = useMarketParam();
  if (!on || value === undefined) return null;
  const at = typeof value === "string" ? value.trim() : "";
  return <Navigate to="/market" search={at && at !== "discover" ? { at } : {}} replace />;
}

/** The Marketplace in the rail: its glyph, filled while its page is open; it opens the page. */
export function MarketRailButton() {
  const open = useOpenMarket();
  const current = useRouterState({
    select: (state) => state.location.pathname === "/market",
  });
  return (
    <Tip label="Marketplace">
      <button
        type="button"
        aria-label="Marketplace"
        aria-current={current ? "page" : undefined}
        data-state={current ? "active" : undefined}
        data-part="rail-item"
        className={railPlaceClass}
        onClick={() => open()}
      >
        <Icon icon={StorefrontIcon} size={20} active={current} />
      </button>
    </Tip>
  );
}
