import { useCallback, useRef, useState } from "react";
import { LocalStore } from "../store.ts";
import { nextLatency } from "./local-echo.ts";

/** Each thread's input round trip in whole ms, for the ⋯ menu; absent until input was sent. */
export const inputLatency = new LocalStore<ReadonlyMap<string, number>>(new Map());

/** A tap or click shown where it landed, in the pane's CSS pixels. */
export interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * The person's own input shown at once, before the page's picture catches up: a ripple where a
 * tap or click lands, and the round trip of every input for the ⋯ menu. Scrolls are never drawn
 * ahead of the page: only Chrome knows which element under the pointer scrolls and whether it
 * still can, so the picture moves only when a frame shows the page moved.
 */
export function useLocalEcho(threadId: string) {
  const [ripples, setRipples] = useState<readonly Ripple[]>([]);
  const ids = useRef(0);
  const latency = useRef<number | undefined>(undefined);

  /** Send input and time its round trip. */
  const timed = useCallback(
    (send: () => void | Promise<void>): Promise<void> => {
      const started = performance.now();
      return Promise.resolve(send()).then(() => {
        const next = nextLatency(latency.current, performance.now() - started);
        latency.current = next;
        const shown = Math.round(next);
        if (inputLatency.get().get(threadId) !== shown)
          inputLatency.set((before) => new Map(before).set(threadId, shown));
      });
    },
    [threadId],
  );

  /** A tap or click at this point of the pane. */
  const ripple = useCallback((x: number, y: number) => {
    const id = ids.current++;
    setRipples((before) => [...before.slice(-3), { id, x, y }]);
  }, []);

  /** A ripple finished its animation. */
  const settled = useCallback((id: number) => {
    setRipples((before) => before.filter((shown) => shown.id !== id));
  }, []);

  return { ripples, ripple, settled, timed };
}
