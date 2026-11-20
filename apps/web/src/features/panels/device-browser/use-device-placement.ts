import { useLayoutEffect, useState } from "react";
import { desktopDeviceTabs } from "@/boot/desktop-device-tabs.ts";
import type { PageBox } from "@/boot/desktop-browser.ts";
import { observeOverlays, overlayBoxes } from "@/lib/overlays.ts";

const intersects = (a: PageBox, b: PageBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a device tab's native view goes: the element's box, never past the window's edges, and
 * hidden while one of the app's overlays (a menu, the address suggestions) is drawn over it,
 * since a native view paints above everything in the window. Pure.
 */
export function devicePlacement(input: {
  box: PageBox;
  window: { width: number; height: number };
  overlays: readonly PageBox[];
}): { bounds: PageBox; visible: boolean } {
  const left = Math.max(0, input.box.x);
  const top = Math.max(0, input.box.y);
  const right = Math.min(input.window.width, input.box.x + input.box.width);
  const bottom = Math.min(input.window.height, input.box.y + input.box.height);
  const bounds = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
  const onScreen = bounds.width > 0 && bounds.height > 0;
  return {
    bounds,
    visible: onScreen && !input.overlays.some((overlay) => intersects(overlay, bounds)),
  };
}

/** Where the page area may move without a resize: a transition or animation on it or above. */
const motionEvents = ["transitionend", "transitioncancel", "animationend"] as const;

/**
 * Keeps a device tab's native view over `element` while `active`, following resizes, window
 * changes, panel motion and overlays; hides it when the tab stops showing. Returns whether the
 * view is shown now. `active` must wait for the tab's open to succeed: a placement main answers
 * `unavailable` (no view yet) is not remembered as placed.
 */
export function useDevicePlacement(
  tabId: string,
  element: HTMLElement | null,
  active: boolean,
): boolean {
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const tabs = desktopDeviceTabs();
    if (!tabs || !element || !active) return;
    let alive = true;
    let last = "";
    let frame = 0;
    let retries = 3;
    const apply = () => {
      frame = 0;
      if (!alive) return;
      const rect = element.getBoundingClientRect();
      const placement = devicePlacement({
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        window: { width: window.innerWidth, height: window.innerHeight },
        overlays: overlayBoxes(element),
      });
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      void tabs.place({ tabId, ...placement }).then((receipt) => {
        if (!alive || last !== key) return;
        setShown(receipt === "shown");
        // Main has no view for the tab (yet): this placement isn't the view's, so the next
        // layout change, or one more try now, places it again.
        if (receipt === "unavailable") {
          last = "";
          if (retries-- > 0) schedule();
        }
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    addEventListener("resize", schedule);
    for (const type of motionEvents) document.addEventListener(type, schedule, true);
    const stopOverlays = observeOverlays(element, schedule);
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      removeEventListener("resize", schedule);
      for (const type of motionEvents) document.removeEventListener(type, schedule, true);
      stopOverlays();
      setShown(false);
      void tabs.place({ tabId, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
    };
  }, [tabId, element, active]);
  return shown;
}
