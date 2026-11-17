import { StorefrontIcon } from "@ace/icons";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { railPlaceClass } from "@/components/rail-place.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useBetaEnabled } from "@/lib/beta-enabled.ts";
import { useOpenMarket } from "@/lib/open-market.ts";
import { formatMarket, parseMarket } from "./market-address.ts";

// The modal and its pages load the first time it opens.
const MarketModal = deferredComponent(() =>
  import("./market-modal.tsx").then((module) => module.MarketModal),
);

/** The `?market=` value on the address, if any. */
function useMarketParam(): string | undefined {
  return useRouterState({ select: (state) => state.location.search.market });
}

/** The Marketplace modal, over any screen while the address has `?market=`. */
export function MarketHost() {
  // Off in Settings › Beta, no address opens it, deep links included.
  const on = useBetaEnabled("marketplace") === true;
  const value = useMarketParam();
  const view = on ? parseMarket(value) : undefined;
  const navigate = useNavigate();
  // Mounted again on each opening, and when a link moves it somewhere the modal didn't: the
  // modal itself writes each move, and those it knows.
  const at = view ? formatMarket(view) : undefined;
  const [known, setKnown] = useState<string | undefined>(undefined);
  const [opening, setOpening] = useState(0);
  if (at !== known) {
    setKnown(at);
    if (at !== undefined) setOpening((count) => count + 1);
  }
  if (!view) return null;
  const write = (market: string | undefined, replace: boolean) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, market }),
      replace,
    });
  return (
    <Suspense fallback={null}>
      <MarketModal.Component
        key={opening}
        view={view}
        onMove={(market) => {
          setKnown(market);
          write(market, true);
        }}
        onClose={() => write(undefined, false)}
      />
    </Suspense>
  );
}

/** The Marketplace in the rail: its glyph, filled while the modal is open; it opens the modal. */
export function MarketRailButton() {
  const open = useOpenMarket();
  const current = useMarketParam() !== undefined;
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
