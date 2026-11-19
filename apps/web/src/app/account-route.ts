import { useEffect, useMemo, useState } from "react";
import type {
  AccountMainMachine,
  AccountMainRoute,
  AccountRouteSource,
} from "@/boot/main-machine.ts";

/**
 * The route of the account machine chosen as this window's: loaded once per choice, so its
 * machine code gate outlives every attempt at it. `routing` is the load itself, for the client
 * each attempt makes; `route` is what it loaded, once it has.
 */
export function useAccountRoute(
  account: AccountMainMachine | undefined,
  source: AccountRouteSource | undefined,
) {
  const routing = useMemo(
    () => (account && source ? source(account) : undefined),
    [account, source],
  );
  const [loaded, setLoaded] = useState<
    { for: Promise<AccountMainRoute | undefined>; route: AccountMainRoute | undefined } | undefined
  >(undefined);
  useEffect(() => {
    if (!routing) return;
    let live = true;
    const settle = (route: AccountMainRoute | undefined) => {
      if (live) setLoaded({ for: routing, route });
    };
    routing.then(settle, () => settle(undefined));
    return () => {
      live = false;
    };
  }, [routing]);
  return { routing, route: loaded && loaded.for === routing ? loaded.route : undefined };
}
