import type { DeepLink } from "../shared/contract.ts";
import type { AceBridge } from "./bridge.ts";

/** The parts of `<html>` the hooks touch. */
export interface PageRoot {
  toggleAttribute(name: string, force?: boolean): boolean;
}

/** The parts of `window` the hooks touch; the DOM is shared with the page's world. */
export interface PageWindow {
  history: Pick<History, "pushState">;
  location: Pick<Location, "pathname" | "search">;
  dispatchEvent(event: Event): boolean;
  document: {
    /** Null while the preload runs before the parser has created `<html>`. */
    readonly documentElement: PageRoot | null;
    addEventListener(type: "DOMContentLoaded", listener: () => void, options: { once: true }): void;
  };
}

/**
 * Desktop events the web app handles without knowing about Electron:
 * - a deep link becomes a history push plus `popstate`, which the router already follows;
 * - waking from sleep fires `online`, which makes the client reconnect immediately;
 * - `<html data-fullscreen>` is present while the window is full screen, so the page's CSS can
 *   drop the room it keeps for the macOS traffic lights.
 */
export function attachPageHooks(
  bridge: Pick<AceBridge, "onDeepLink" | "onSystemResumed" | "window">,
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
    markFullScreen(bridge.window, page.document),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

function markFullScreen(
  window: Pick<AceBridge["window"], "state" | "onChange">,
  document: PageWindow["document"],
): () => void {
  let fullScreen: boolean | undefined;
  let changed = false;
  const apply = () => {
    if (fullScreen !== undefined)
      document.documentElement?.toggleAttribute("data-fullscreen", fullScreen);
  };
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  const stop = window.onChange((state) => {
    changed = true;
    fullScreen = state.fullScreen;
    apply();
  });
  window.state().then(
    (state) => {
      // A change that arrived meanwhile is newer than this answer.
      if (changed) return;
      fullScreen = state.fullScreen;
      apply();
    },
    () => {},
  );
  return stop;
}
