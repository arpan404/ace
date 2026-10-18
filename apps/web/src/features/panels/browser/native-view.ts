import { useLayoutEffect, useState, type RefObject } from "react";
import {
  desktopBrowserViews,
  type NativeViewPlacement,
  type PageBox,
} from "@/boot/desktop-browser.ts";

import { NativePlacement, placementTimer } from "./native-placement.ts";
import { nextFrame } from "@/lib/next-frame.ts";
import { observeOverlays, overlayBoxes } from "@/lib/overlays.ts";

interface Size {
  width: number;
  height: number;
}

/** The space a device-sized page keeps around it, as the picture's `p-6` does. */
const devicePadding = 24;
/** Where the page area may move without a resize: a transition or animation on it or above. */
const motionEvents = [
  "transitionrun",
  "transitionend",
  "transitioncancel",
  "animationstart",
  "animationend",
  "animationcancel",
] as const;
/** How long after a window's last resize event the page area is measured again. */
const resizeSettleMs = 150;

const intersects = (a: PageBox, b: PageBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where the desktop's embedded view of a page goes, in the page's CSS pixels: the tab's whole
 * page area, or a device-sized box centred in it, never past the window's edges. Overlays never
 * move or resize it: `covered` says an overlay (a menu, a popover, the address suggestions)
 * is drawn over it, and the view is then held as a still picture in place (`useNativeView`).
 */
export function nativeViewPlacement(input: {
  area: PageBox;
  window: Size;
  device?: Size | undefined;
  overlays: readonly PageBox[];
  /** Space kept around a device-sized page; picture-in-picture keeps none. */
  padding?: number | undefined;
}): { bounds: PageBox; visible: boolean; covered: boolean } {
  const { area, device } = input;
  const padding = input.padding ?? devicePadding;
  let box = area;
  if (device) {
    const scale = Math.min(
      1,
      Math.max(0, area.width - 2 * padding) / device.width,
      Math.max(0, area.height - 2 * padding) / device.height,
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
  const bounds = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
  const visible = bounds.width > 0 && bounds.height > 0;
  return {
    bounds,
    visible,
    covered: visible && input.overlays.some((overlay) => intersects(overlay, bounds)),
  };
}

/** The view's picture held exactly where the view is, while something covers it. */
export interface FrozenPage {
  src: string;
  /** Relative to the page area. */
  box: PageBox;
}

/**
 * In the desktop app, draws the thread's embedded browser view over `area` while `active`,
 * and follows the area as panels resize, move, collapse or switch tabs. Leaving (a tab switch
 * hides this one in an `<Activity>`, a closed panel unmounts it) hides the view again. In a
 * browser there is no native view and this does nothing.
 *
 * A native view paints above everything in the window, so a menu or popover opened over it
 * would be hidden. Instead of moving the page aside (it would jump and reflow), the view is
 * captured as it is, its picture (`frozen`) is drawn in exactly its place, and only then is the
 * view hidden; it comes back, at the same bounds, once the overlay is gone. The page keeps
 * running underneath the whole time.
 */
export function useNativeView(
  threadId: string,
  area: RefObject<HTMLElement | null>,
  active: boolean,
  options: {
    device: NativeViewPlacement["device"];
    padding?: number;
    /** One tab of the thread (split view); omitted: the tab the thread shows. */
    tabId?: string | undefined;
  },
): { shown: boolean; frozen: FrozenPage | undefined } {
  const [shown, setShown] = useState(false);
  const [frozen, setFrozen] = useState<FrozenPage>();
  const deviceWidth = options.device?.width;
  const deviceHeight = options.device?.height;
  const deviceMobile = options.device?.mobile;
  const deviceScaleFactor = options.device?.deviceScaleFactor;
  const padding = options.padding;
  const tabId = options.tabId;
  useLayoutEffect(() => {
    const views = desktopBrowserViews();
    const element = area.current;
    if (!views || !element || !active) return;
    const size =
      deviceWidth !== undefined && deviceHeight !== undefined
        ? { width: deviceWidth, height: deviceHeight, mobile: deviceMobile, deviceScaleFactor }
        : undefined;
    let rect: PageBox | undefined;
    let alive = true;
    /** The picture held in the view's place, while one is. */
    let held: FrozenPage | undefined;
    /** A capture in flight for the overlay that is open now. */
    let capturing = false;
    /** This cover already asked for a picture (it may have got none: the view then hides). */
    let attempted = false;
    let cancelHide: (() => void) | undefined;
    const controller = new NativePlacement({
      place: (placement) => views.place(placement),
      changed: (visible) => {
        setShown(visible);
        // Back on screen: the picture has done its job.
        if (visible && held) {
          held = undefined;
          setFrozen(undefined);
        }
      },
      after: placementTimer,
    });
    const freeze = (placement: { bounds: PageBox }) => {
      if (capturing || held || attempted || !rect) return;
      capturing = true;
      attempted = true;
      const origin = rect;
      void views
        .snapshot(threadId, tabId)
        .then(async (src) => {
          if (!src) return undefined;
          // Decoded before it is shown, so it paints in the same frame it is placed.
          const image = new Image();
          image.src = src;
          if (typeof image.decode === "function") await image.decode().catch(() => {});
          return src;
        })
        .catch(() => undefined)
        .then((src) => {
          capturing = false;
          if (!alive) return;
          const picture = src
            ? {
                src,
                box: {
                  x: placement.bounds.x - origin.x,
                  y: placement.bounds.y - origin.y,
                  width: placement.bounds.width,
                  height: placement.bounds.height,
                },
              }
            : undefined;
          held = picture;
          if (picture) setFrozen(picture);
          // Hide the view only once the picture has painted in its place.
          cancelHide?.();
          cancelHide = nextFrame(() => {
            cancelHide = nextFrame(() => {
              cancelHide = undefined;
              place();
            });
          });
        });
    };
    const place = () => {
      if (!rect || !alive) return;
      const placement = nativeViewPlacement({
        area: rect,
        window: { width: innerWidth, height: innerHeight },
        device: size,
        overlays: overlayBoxes(element),
        padding,
      });
      // Covered and not yet captured: keep showing the page until its picture is ready.
      if (!placement.covered) attempted = false;
      else freeze(placement);
      const hidden = placement.covered && !capturing;
      controller.place({
        threadId,
        ...(tabId === undefined ? {} : { tabId }),
        bounds: placement.bounds,
        visible: placement.visible && !hidden,
        ...(size ? { device: size } : {}),
      });
    };
    let frame = 0;
    /** Transitions and animations running on the area or an ancestor (a panel sliding in). */
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
    // Followed frame by frame until they end: a moving box raises no resize or mutation.
    const transition = (event: TransitionEvent | AnimationEvent) => {
      if (!(event.target instanceof HTMLElement) || !ancestors.includes(event.target)) return;
      const name = "propertyName" in event ? event.propertyName : event.animationName;
      const key = `${ancestors.indexOf(event.target)}:${event.type[0]}:${name}`;
      if (event.type === "transitionrun" || event.type === "animationstart") transitions.add(key);
      else transitions.delete(key);
      schedule();
    };
    for (const type of motionEvents) document.addEventListener(type, transition);
    // A window resize can settle the layout a frame or more after its last event (panel sizes
    // clamp to the new width in an effect): measure once more after it goes quiet.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const resized = () => {
      schedule();
      clearTimeout(settle);
      settle = setTimeout(schedule, resizeSettleMs);
    };
    addEventListener("resize", resized);
    document.addEventListener("scroll", schedule, true);
    measure();
    const stopRect = () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      resize?.disconnect();
      mutations.disconnect();
      removeEventListener("resize", resized);
      document.removeEventListener("scroll", schedule, true);
      for (const type of motionEvents) document.removeEventListener(type, transition);
    };
    const stopVisibility = views.onVisibility((id, visible, tab) =>
      controller.visibility(id, visible, tab),
    );
    const stopOverlays = observeOverlays(element, schedule);
    return () => {
      alive = false;
      cancelHide?.();
      controller.close();
      setFrozen(undefined);
      stopRect();
      stopVisibility();
      stopOverlays();
    };
  }, [
    threadId,
    area,
    active,
    deviceWidth,
    deviceHeight,
    deviceMobile,
    deviceScaleFactor,
    padding,
    tabId,
  ]);
  return { shown: active && shown, frozen: active ? frozen : undefined };
}
