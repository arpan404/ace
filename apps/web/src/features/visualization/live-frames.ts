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

/** How far outside the viewport a frame stays loaded. */
const margin = "100% 0px";

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
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) pool.near(id, entry.isIntersecting);
      },
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      pool.near(id, false);
    };
  }, [pool, id, element]);
  return useSyncExternalStore(
    (listener) => pool.subscribe(listener),
    () => pool.live(id),
  );
}
