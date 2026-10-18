import { h, place } from "./dom.ts";

export interface OverlayHost {
  host: HTMLElement;
  layer: HTMLElement;
  /** Re-raise into the top layer, e.g. after the page opened a modal of its own. */
  raise(): void;
  dispose(): void;
}

/** Page CSS can reach the host element, so every property that matters is inline and important. */
const hostStyle: Record<string, string> = {
  all: "initial",
  display: "block",
  position: "fixed",
  inset: "0",
  width: "auto",
  height: "auto",
  "max-width": "none",
  "max-height": "none",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  "pointer-events": "none",
  "z-index": "2147483647",
  transform: "none",
  filter: "none",
  opacity: "1",
  visibility: "visible",
};

const bubbling = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
] as const;

/**
 * One host on `<html>` with a closed shadow root. When the Popover API exists the host sits in
 * the top layer so page stacking contexts, transforms and z-index wars cannot cover it.
 */
export function createHost(sheet: CSSStyleSheet, tag = "ace-annotation-layer"): OverlayHost {
  const host = document.createElement(tag);
  place(host, hostStyle, true);
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.adoptedStyleSheets = [sheet];
  const layer = h("div", { class: "layer" });
  shadow.append(layer);
  // The overlay's own clicks end at its root: page "click outside" handlers never see them.
  for (const type of bubbling) layer.addEventListener(type, (event) => event.stopPropagation());
  const popover = typeof host.showPopover === "function";
  if (popover) host.setAttribute("popover", "manual");
  const raise = () => {
    if (!host.isConnected) document.documentElement.append(host);
    if (!popover) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      /* Detached or not yet rendered: the next mutation retries. */
    }
  };
  raise();
  // Frameworks that own <html> can drop unknown children; put the host back.
  const keeper = new MutationObserver(() => {
    if (!host.isConnected) raise();
  });
  keeper.observe(document.documentElement, { childList: true });
  return {
    host,
    layer,
    raise,
    dispose() {
      keeper.disconnect();
      host.remove();
    },
  };
}
