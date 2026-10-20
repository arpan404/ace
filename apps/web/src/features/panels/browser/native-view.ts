import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
  /** The area is the device's own viewport (the device toolbar's frame): fill it exactly. */
  exact?: boolean | undefined;
  overlays: readonly PageBox[];
  /** Space kept around a device-sized page; picture-in-picture keeps none. */
  padding?: number | undefined;
}): { bounds: PageBox; visible: boolean; covered: boolean } {
  const { area, device } = input;
  const padding = input.padding ?? devicePadding;
  let box = area;
  if (device && !input.exact) {
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
 * view hidden, marked `covered`; it comes back, at the same bounds, once the overlay is gone.
 * Meanwhile the page keeps running, rendering and playing sound, and the caller draws its live
 * video in its place once a newer picture replaces the still (`useCoverStill`).
 */
export function useNativeView(
  threadId: string,
  area: RefObject<HTMLElement | null>,
  active: boolean,
  options: {
    device: NativeViewPlacement["device"];
    exact?: boolean | undefined;
    padding?: number;
    /** One tab of the thread (split view); omitted: the tab the thread shows. */
    tabId?: string | undefined;
    /** Picture-in-picture: the page takes no clicks; the desktop reports them (`onRestore`). */
    picture?: boolean | undefined;
  },
): { shown: boolean; frozen: FrozenPage | undefined } {
  const [shown, setShown] = useState(false);
  const [frozen, setFrozen] = useState<FrozenPage>();
  // The device can change every frame (a device toolbar drag): it is read when placing, and a
  // change re-places the view without taking it down.
  const latest = useRef(options);
  const replace = useRef<() => void>(undefined);
  const deviceKey = options.device
    ? `${options.device.width}x${options.device.height}:${options.device.mobile}:${options.device.deviceScaleFactor}:${options.exact}`
    : `none:${options.exact}`;
  const placeKey = `${deviceKey}:${options.padding ?? 0}:${options.picture === true}`;
  const tabId = options.tabId;
  const sync = useEffectEvent(() => {
    latest.current = options;
    replace.current?.();
  });
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the key names the change.
  useLayoutEffect(() => sync(), [placeKey]);
  useLayoutEffect(() => {
    const views = desktopBrowserViews();
    const element = area.current;
    if (!views || !element || !active) return;
    const deviceNow = () => {
      const device = latest.current.device;
      return device
        ? {
            width: device.width,
            height: device.height,
            mobile: device.mobile,
            deviceScaleFactor: device.deviceScaleFactor,
          }
        : undefined;
    };
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
      const size = deviceNow();
      const box = nativeViewPlacement({
        area: rect,
        window: { width: innerWidth, height: innerHeight },
        device: size,
        exact: latest.current.exact,
        overlays: overlayBoxes(element),
        padding: latest.current.padding,
      });
      // Covered and not yet captured: keep showing the page until its picture is ready.
      if (!box.covered) attempted = false;
      else freeze(box);
      const hidden = box.covered && !capturing;
      controller.place({
        threadId,
        ...(tabId === undefined ? {} : { tabId }),
        bounds: box.bounds,
        visible: box.visible && !hidden,
        ...(box.visible && hidden ? { covered: true } : {}),
        ...(latest.current.picture ? { picture: true } : {}),
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
    replace.current = schedule;
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
      replace.current = undefined;
      cancelHide?.();
      controller.close();
      setFrozen(undefined);
      stopRect();
      stopVisibility();
      stopOverlays();
    };
  }, [threadId, area, active, tabId]);
  return { shown: active && shown, frozen: active ? frozen : undefined };
}
