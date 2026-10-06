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
  /** The connection the renderer showing the view holds the page through, if it does. */
  owner: string | undefined;
}

interface Claim {
  device?: NativeDevice | undefined;
  bounds: Rect;
  visible: boolean;
  owner: string | undefined;
  order: number;
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
      owner?: string | undefined;
      device?: NativeDevice | undefined;
    },
  ): ResolvedPlacement {
    let hosts = this.claims.get(threadId);
    if (!hosts) this.claims.set(threadId, (hosts = new Map()));
    hosts.set(host, {
      bounds: claim.bounds,
      device: claim.device,
      visible: claim.visible,
      owner: claim.owner,
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
        owner: shown[1].owner,
        device: shown[1].device,
      };
    return { host: latest?.[0], bounds: latest?.[1].bounds, visible: false, owner: undefined };
  }
}
