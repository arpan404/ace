import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  desktopBrowserViews,
  type NativeViewPlacement,
  type PageBox,
} from "@/boot/desktop-browser.ts";

import { NativePlacement, placementTimer } from "./native-placement.ts";
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
 * page area, or a device-sized box centred in it, never past the window's edges. Overlays clip
 * the native view to its largest clear rectangle so menus and notifications stay readable.
 * A fully covered page falls back to its last screencast frame.
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
    const scale = Math.min(
      1,
      Math.max(0, area.width - 2 * devicePadding) / device.width,
      Math.max(0, area.height - 2 * devicePadding) / device.height,
    );
    const width = device.width * scale;
    const height = device.height * scale;
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
  let bounds = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
  for (const overlay of input.overlays) {
    if (!intersects(overlay, bounds)) continue;
    // Keep painting the largest unobstructed rectangle beside a portal.
    const edgeRight = bounds.x + bounds.width,
      edgeBottom = bounds.y + bounds.height;
    const candidates = [
      { ...bounds, width: Math.max(0, overlay.x - bounds.x) },
      {
        ...bounds,
        x: overlay.x + overlay.width,
        width: Math.max(0, edgeRight - overlay.x - overlay.width),
      },
      { ...bounds, height: Math.max(0, overlay.y - bounds.y) },
      {
        ...bounds,
        y: overlay.y + overlay.height,
        height: Math.max(0, edgeBottom - overlay.y - overlay.height),
      },
    ];
    bounds = candidates.toSorted((a, b) => b.width * b.height - a.width * a.height)[0] ?? bounds;
  }
  const empty = bounds.width <= 0 || bounds.height <= 0;
  return {
    bounds,
    visible: !empty,
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
    device: NativeViewPlacement["device"];
    /** The connection through which this client holds the page, while it does. */
    owner: string | undefined;
    /** They clicked or typed on the view without control. */
    onWantsControl(): void;
  },
): boolean {
  const [shown, setShown] = useState(false);
  const deviceWidth = options.device?.width;
  const deviceHeight = options.device?.height;
  const deviceMobile = options.device?.mobile;
  const deviceScaleFactor = options.device?.deviceScaleFactor;
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
        ? { width: deviceWidth, height: deviceHeight, mobile: deviceMobile, deviceScaleFactor }
        : undefined;
    let rect: PageBox | undefined;
    const controller = new NativePlacement({
      place: (placement) => views.place(placement),
      changed: setShown,
      after: placementTimer,
    });
    const place = () => {
      if (!rect) return;
      const placement = nativeViewPlacement({
        area: rect,
        window: { width: innerWidth, height: innerHeight },
        device: size,
        overlays: overlayBoxes(element),
      });
      const held = placement.visible ? ownerRef.current : undefined;
      const next = {
        threadId,
        ...placement,
        ...(held ? { owner: held } : {}),
        ...(size ? { device: size } : {}),
      };
      controller.place(next);
    };
    replace.current = place;
    let frame = 0;
    const transitions = new Set<string>();
    const measure = () => {
      frame = 0;
      const next = element.getBoundingClientRect();
      rect = { x: next.x, y: next.y, width: next.width, height: next.height };
      place();
      if (transitions.size) frame = requestAnimationFrame(measure);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const ancestors: HTMLElement[] = [];
    for (let node: HTMLElement | null = element; node; node = node.parentElement)
      ancestors.push(node);
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    for (const node of ancestors) {
      resize?.observe(node);
      mutations.observe(node, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });
    }
    const transition = (event: TransitionEvent) => {
      if (!(event.target instanceof HTMLElement) || !ancestors.includes(event.target)) return;
      const key = `${ancestors.indexOf(event.target)}:${event.propertyName}`;
      if (event.type === "transitionrun") transitions.add(key);
      else transitions.delete(key);
      schedule();
    };
    for (const type of ["transitionrun", "transitionend", "transitioncancel"] as const)
      document.addEventListener(type, transition);
    addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    measure();
    const stopRect = () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      for (const type of ["transitionrun", "transitionend", "transitioncancel"] as const)
        document.removeEventListener(type, transition);
    };
    const stopVisibility = views.onVisibility((id, visible) => controller.visibility(id, visible));
    const stopOverlays = observeOverlays(element, schedule);
    const stopWants = views.onWantsControl((id) => {
      if (id === threadId) wantsControl();
    });
    return () => {
      controller.close();
      replace.current = undefined;
      stopRect();
      stopVisibility();
      stopOverlays();
      stopWants();
    };
  }, [threadId, area, active, deviceWidth, deviceHeight, deviceMobile, deviceScaleFactor]);
  return active && shown;
}
