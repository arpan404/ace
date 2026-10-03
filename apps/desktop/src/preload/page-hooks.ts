import type { DeepLink } from "../shared/contract.ts";
import type { AceBridge } from "./bridge.ts";

/** The parts of `window` the hooks touch; the DOM is shared with the page's world. */
export interface PageWindow {
  history: Pick<History, "pushState">;
  location: Pick<Location, "pathname" | "search">;
  dispatchEvent(event: Event): boolean;
}

/**
 * Desktop events the web app handles without knowing about Electron:
 * - a deep link becomes a history push plus `popstate`, which the router already follows;
 * - waking from sleep fires `online`, which makes the client reconnect immediately.
 */
export function attachPageHooks(
  bridge: Pick<AceBridge, "onDeepLink" | "onSystemResumed">,
  page: PageWindow,
  route: (link: DeepLink) => string,
): () => void {
  const stops = [
    bridge.onDeepLink((link) => {
      const target = route(link);
      if (page.location.pathname + page.location.search === target) return;
      page.history.pushState(null, "", target);
      page.dispatchEvent(new Event("popstate"));
    }),
    bridge.onSystemResumed(() => page.dispatchEvent(new Event("online"))),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
