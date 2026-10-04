import { useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { desktopBrowserViews, type PageBox } from "@/boot/desktop-browser.ts";
import { observeRect } from "@/lib/element-rect.ts";
import { observeOverlays, overlayBoxes } from "@/lib/overlays.ts";

interface Size {
  width: number;
  height: number;
}

/** The space a device-sized page keeps around it, as the picture's `p-6` does. */
const devicePadding = 24;

const intersects = (a: PageBox, b: PageBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where the desktop's embedded view of a page goes, in the page's CSS pixels: the tab's whole
 * page area, or a device-sized box centred in it, never past the window's edges. It hides while
 * anything drawn over the app (a menu, a dialog, a toast) covers it, since a native view would
 * be drawn on top of that; the last screencast frame shows in its place meanwhile.
 */
export function nativeViewPlacement(input: {
  area: PageBox;
  window: Size;
  device?: Size | undefined;
  overlays: readonly PageBox[];
}): { bounds: PageBox; visible: boolean } {
  const { area, device } = input;
  let box = area;
  if (device) {
    const width = Math.min(device.width, Math.max(0, area.width - 2 * devicePadding));
    const height = Math.min(device.height, Math.max(0, area.height - 2 * devicePadding));
    box = {
      x: area.x + (area.width - width) / 2,
      y: area.y + (area.height - height) / 2,
      width,
      height,
    };
  }
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(input.window.width, box.x + box.width);
  const bottom = Math.min(input.window.height, box.y + box.height);
  const bounds = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
  const empty = bounds.width <= 0 || bounds.height <= 0;
  return {
    bounds,
    visible: !empty && !input.overlays.some((overlay) => intersects(overlay, bounds)),
  };
}

/**
 * In the desktop app, draws the thread's embedded browser view over `area` while `active`,
 * and follows the area as panels resize, move, collapse or switch tabs. Leaving (a tab switch
 * hides this one in an `<Activity>`, a closed panel unmounts it) hides the view again. In a
 * browser there is no native view and this does nothing.
 */
export function useNativeView(
  threadId: string,
  area: RefObject<HTMLElement | null>,
  active: boolean,
  options: {
    device: Size | undefined;
    /** The connection through which this client holds the page, while it does. */
    owner: string | undefined;
    /** They clicked or typed on the view without control. */
    onWantsControl(): void;
  },
): void {
  const deviceWidth = options.device?.width;
  const deviceHeight = options.device?.height;
  const { owner } = options;
  const wantsControl = useEffectEvent(options.onWantsControl);
  // Control changes update the placement in place, without hiding the view in between.
  const ownerRef = useRef(owner);
  const replace = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    ownerRef.current = owner;
    replace.current?.();
  }, [owner]);
  useLayoutEffect(() => {
    const views = desktopBrowserViews();
    const element = area.current;
    if (!views || !element || !active) return;
    const size =
      deviceWidth !== undefined && deviceHeight !== undefined
        ? { width: deviceWidth, height: deviceHeight }
        : undefined;
    let rect: PageBox | undefined;
    let sent = "";
    let bounds: PageBox = { x: 0, y: 0, width: 0, height: 0 };
    const place = () => {
      if (!rect) return;
      const placement = nativeViewPlacement({
        area: rect,
        window: { width: innerWidth, height: innerHeight },
        device: size,
        overlays: overlayBoxes(element),
      });
      const held = placement.visible ? ownerRef.current : undefined;
      const next = { threadId, ...placement, ...(held ? { owner: held } : {}) };
      const key = JSON.stringify(next);
      if (key === sent) return;
      sent = key;
      bounds = placement.bounds;
      void views.place(next).catch(() => {});
    };
    replace.current = place;
    const stopRect = observeRect(element, (next) => {
      rect = { x: next.x, y: next.y, width: next.width, height: next.height };
      place();
    });
    const stopOverlays = observeOverlays(element, place);
    const stopWants = views.onWantsControl((id) => {
      if (id === threadId) wantsControl();
    });
    return () => {
      replace.current = undefined;
      stopRect();
      stopOverlays();
      stopWants();
      void views.place({ threadId, bounds, visible: false }).catch(() => {});
    };
  }, [threadId, area, active, deviceWidth, deviceHeight]);
}
