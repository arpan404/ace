import type { BrowserPlacement } from "../../shared/contract.ts";
export type NativeDevice = NonNullable<BrowserPlacement["device"]>;
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a thread's view goes: the window (by its renderer's id) and the box inside it. */
export interface ResolvedPlacement {
  /** The renderer whose window holds the view; undefined until one has placed it. */
  host: number | undefined;
  device?: NativeDevice | undefined;
  /** In window DIPs; undefined until a renderer has placed the view. */
  bounds: Rect | undefined;
  visible: boolean;
  /** Hidden only while the renderer's menu covers it (`BrowserPlacement.covered`). */
  covered?: boolean;
}

interface Claim {
  device?: NativeDevice | undefined;
  bounds: Rect;
  visible: boolean;
  covered?: boolean | undefined;
  order: number;
}

/**
 * Chromium emulation that lays a device out at its size and draws it filling `bounds`. The
 * device is in the app renderer's CSS pixels and `bounds` in window DIPs. Chromium's emulated
 * size is in DIPs, and page zoom only changes how many CSS pixels fit in it, so zoom must not
 * shrink the scale: the app's zoom grows the emulated size instead, as it grows the panel.
 */
export function deviceEmulation(device: NativeDevice, bounds: Rect, appZoom: number) {
  const zoom = Number.isFinite(appZoom) && appZoom > 0 ? appZoom : 1;
  const width = Math.max(1, Math.round(device.width * zoom));
  const height = Math.max(1, Math.round(device.height * zoom));
  return {
    width,
    height,
    deviceScaleFactor: device.deviceScaleFactor ?? 0,
    mobile: device.mobile ?? false,
    scale: bounds.width / width,
  };
}

/**
 * Chromium emulation for a size an agent asked for in CSS pixels (`resize`, `emulate`), on a
 * view the panel shows in `bounds` (window DIPs) zoomed by `zoom` (the app's zoom). Emulated
 * sizes and scale factors are DIPs, which zoom multiplies, so the size grows by the zoom and
 * the scale factor shrinks by it: the page then lays out at exactly the size asked and reports
 * the scale factor asked (0 keeps the screen's). The whole device is drawn fitted into the box,
 * never enlarged. Other emulation fields pass through.
 */
export function agentEmulation(
  device: Record<string, unknown> & { width: number; height: number },
  bounds: Rect,
  zoom: number,
): Record<string, unknown> & {
  width: number;
  height: number;
  deviceScaleFactor: number;
  scale: number;
} {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // Chromium lays out the whole CSS pixels that fit: round up, so none is lost to rounding.
  const width = Math.max(1, Math.ceil(device.width * factor));
  const height = Math.max(1, Math.ceil(device.height * factor));
  const asked = device["deviceScaleFactor"];
  const deviceScaleFactor = typeof asked === "number" && asked > 0 ? asked / factor : 0;
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  return { mobile: false, ...device, width, height, deviceScaleFactor, scale };
}

/**
 * A phone sized a tab from elsewhere (`ace.touchDevice`): the page lays out as that phone
 * (its CSS size, mobile, the screen's own scale) and the view takes the phone's shape, so its
 * captured picture is the phone's page and nothing else. Shown in a panel (`panel`, window
 * DIPs), the view is the phone drawn as large as fits, centred at the panel's top; unshown, it
 * is the phone's size. `zoom` is the app's zoom, as for `agentEmulation`.
 */
export function touchDeviceLayout(
  device: { width: number; height: number },
  panel: Rect | undefined,
  zoom: number,
): { emulation: ReturnType<typeof agentEmulation>; bounds: Rect } {
  const box = panel ?? { x: 0, y: 0, width: Infinity, height: Infinity };
  const emulation = agentEmulation(
    { width: device.width, height: device.height, deviceScaleFactor: 0, mobile: true },
    box,
    zoom,
  );
  const width = Math.max(1, Math.round(emulation.width * emulation.scale));
  const height = Math.max(1, Math.round(emulation.height * emulation.scale));
  const bounds = panel
    ? { x: panel.x + Math.floor((panel.width - width) / 2), y: panel.y, width, height }
    : { x: 0, y: 0, width, height };
  return { emulation, bounds };
}

/**
 * A renderer's box (CSS pixels of its page) in its window's DIPs. Edges are rounded, not
 * sizes, so two boxes that touch in CSS still touch on screen.
 */
export function toWindowBounds(css: Rect, zoom: number): Rect {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const left = Math.round(css.x * scale);
  const top = Math.round(css.y * scale);
  const right = Math.round((css.x + css.width) * scale);
  const bottom = Math.round((css.y + css.height) * scale);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const empty = (rect: Rect) => rect.width <= 0 || rect.height <= 0;

/**
 * What each app window's renderer last asked for each thread's embedded view. A view shows
 * where a renderer most recently showed it; one renderer hiding it (a tab switch, a collapsed
 * panel) leaves it showing where another still does. A renderer that reloads or goes away
 * loses all its claims, since it can no longer take them back.
 */
export class PlacementBook {
  private claims = new Map<string, Map<number, Claim>>();
  private order = 0;

  /** Record a renderer's request; returns the view's placement now. */
  set(
    threadId: string,
    host: number,
    claim: {
      bounds: Rect;
      visible: boolean;
      covered?: boolean | undefined;
      device?: NativeDevice | undefined;
    },
  ): ResolvedPlacement {
    let hosts = this.claims.get(threadId);
    if (!hosts) this.claims.set(threadId, (hosts = new Map()));
    hosts.set(host, {
      bounds: claim.bounds,
      device: claim.device,
      visible: claim.visible,
      covered: !claim.visible && claim.covered === true,
      order: ++this.order,
    });
    return this.resolve(threadId);
  }

  /** A renderer is done with a thread's view: unlike hiding it, nothing of its claim stays. */
  release(threadId: string, host: number): ResolvedPlacement {
    const hosts = this.claims.get(threadId);
    hosts?.delete(host);
    if (hosts?.size === 0) this.claims.delete(threadId);
    return this.resolve(threadId);
  }

  /** The thread's view is gone: forget every renderer's claim on it. */
  forget(threadId: string): void {
    this.claims.delete(threadId);
  }

  /** Drop every claim of a renderer; returns the threads whose placement may have changed. */
  forgetHost(host: number): string[] {
    const changed: string[] = [];
    for (const [threadId, hosts] of this.claims)
      if (hosts.delete(host)) {
        changed.push(threadId);
        if (hosts.size === 0) this.claims.delete(threadId);
      }
    return changed;
  }

  resolve(threadId: string): ResolvedPlacement {
    let shown: [number, Claim] | undefined;
    let latest: [number, Claim] | undefined;
    for (const entry of this.claims.get(threadId) ?? []) {
      const claim = entry[1];
      if (!latest || claim.order > latest[1].order) latest = entry;
      if (claim.visible && !empty(claim.bounds) && (!shown || claim.order > shown[1].order))
        shown = entry;
    }
    if (shown)
      return {
        host: shown[0],
        bounds: shown[1].bounds,
        visible: true,
        device: shown[1].device,
      };
    return {
      host: latest?.[0],
      bounds: latest?.[1].bounds,
      visible: false,
      ...(latest?.[1].covered ? { covered: true } : {}),
    };
  }
}
