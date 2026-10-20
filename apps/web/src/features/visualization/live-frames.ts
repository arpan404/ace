import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

/**
 * Which chat visualizations keep a live page. Each one runs scripts in its own frame (a renderer
 * process on desktop), so only frames near the viewport stay loaded, and at most `limit` of
 * them: the most recently revealed. An unloaded frame keeps its height and reloads when it
 * comes back.
 */
export class LiveFrames {
  readonly limit: number;
  #near: string[] = [];
  #listeners = new Set<() => void>();
  constructor(limit: number) {
    this.limit = limit;
  }
  /** Reports whether a frame is near the viewport. */
  near(id: string, near: boolean): void {
    const index = this.#near.indexOf(id);
    if (index >= 0) this.#near.splice(index, 1);
    if (near) this.#near.push(id);
    if (index >= 0 || near) for (const listener of this.#listeners) listener();
  }
  live(id: string): boolean {
    const index = this.#near.indexOf(id);
    return index >= 0 && index >= this.#near.length - this.limit;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export const LiveFramesContext = createContext<LiveFrames | undefined>(undefined);

/** A frame loads within the inner margin and unloads outside the outer margin. */
const innerMargin = "200% 0px";
const outerMargin = "400% 0px";

/** Whether a frame stays near: in the inner margin it loads, outside the outer it unloads. */
export function nextNear(previous: boolean, inInner: boolean, inOuter: boolean): boolean {
  if (inInner) return true;
  if (!inOuter) return false;
  return previous;
}

/**
 * Whether the visualization in `element` should hold a live page. Without a provider (or an
 * IntersectionObserver, as in tests) every frame is live.
 */
export function useLiveFrame(id: string, element: HTMLElement | null): boolean {
  const frames = useContext(LiveFramesContext);
  const [fallback] = useState(() => new LiveFrames(Number.POSITIVE_INFINITY));
  const pool = frames ?? fallback;
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") {
      pool.near(id, true);
      return () => pool.near(id, false);
    }
    let inInner = false;
    let inOuter = false;
    let current = false;
    const report = () => {
      const next = nextNear(current, inInner, inOuter);
      if (next === current) return;
      current = next;
      pool.near(id, next);
    };
    const innerObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        inInner = entry.isIntersecting;
        report();
      },
      { rootMargin: innerMargin },
    );
    const outerObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        inOuter = entry.isIntersecting;
        report();
      },
      { rootMargin: outerMargin },
    );
    innerObserver.observe(element);
    outerObserver.observe(element);
    return () => {
      innerObserver.disconnect();
      outerObserver.disconnect();
      pool.near(id, false);
    };
  }, [pool, id, element]);
  return useSyncExternalStore(
    (listener) => pool.subscribe(listener),
    () => pool.live(id),
  );
}
