import { useSyncExternalStore } from "react";
import { whenIdle } from "./idle.ts";

/**
 * Code a closed popup never runs, loaded after the first paint: on demand, or once the browser is
 * idle. Once in, it stays; a failed load is forgotten, so the next request tries again.
 */
export interface DeferredPart<T> {
  /** The loaded code, or undefined until it has arrived. */
  current(): T | undefined;
  load(): Promise<T>;
  /** Called once, when the code arrives. */
  subscribe(listener: () => void): () => void;
  /** Loads it once the browser is idle, the first time any caller asks. */
  warm(): void;
}

export function deferredPart<T>(load: () => Promise<T>): DeferredPart<T> {
  let value: T | undefined;
  let loading: Promise<T> | undefined;
  let warming = false;
  const listeners = new Set<() => void>();
  const part: DeferredPart<T> = {
    current: () => value,
    load: () =>
      (loading ??= load().then(
        (loaded) => {
          value = loaded;
          for (const listener of listeners) listener();
          return loaded;
        },
        (cause: unknown) => {
          loading = undefined;
          throw cause;
        },
      )),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    warm() {
      if (warming) return;
      warming = true;
      whenIdle(() => void part.load().catch(() => {}), 4_000);
    },
  };
  return part;
}

/** The part's code once it has arrived; renders again when it does. */
export function usePart<T>(part: DeferredPart<T>): T | undefined {
  return useSyncExternalStore(part.subscribe, part.current, part.current);
}
