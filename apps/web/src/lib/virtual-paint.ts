import { measureElement as measureRow, type Virtualizer } from "@tanstack/react-virtual";
import { useReducer, useState } from "react";
import { flushSync } from "react-dom";

/** The virtualizer options this sets. */
export interface PlaceBeforePaint<S extends Element | Window, I extends Element> {
  measureElement(
    element: I,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<S, I>,
  ): number;
  onChange(): void;
}

/**
 * Rows learn their size from a ResizeObserver, whose callback runs after layout and before the
 * frame paints. TanStack Virtual re-renders for a new size on React's normal schedule, after
 * that paint, so for a frame the rows below a row that grew stay where its old size put them,
 * drawn over it (a thread opening while its rows fill in, a message streaming above the
 * Working line). Rendering the new positions once the observer's sizes are in, still before the
 * paint, means no frame shows rows on top of each other. One render per observer delivery,
 * however many rows it resized; a delivery that changed no size renders nothing.
 */
export function usePlaceBeforePaint<
  S extends Element | Window,
  I extends Element,
>(): PlaceBeforePaint<S, I> {
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const [options] = useState<PlaceBeforePaint<S, I>>(() => {
    // An observer delivery is being handled, and whether it moved anything.
    let delivering = false;
    let moved = false;
    // Runs once the observer's callback has returned, before the browser goes on to paint.
    const place = () => {
      delivering = false;
      if (!moved) return;
      moved = false;
      flushSync(redraw);
    };
    return {
      measureElement(element, entry, instance) {
        // Only the observer passes an entry; a row's ref measures during React's commit, whose
        // updates already land before the paint.
        if (entry && !delivering) {
          delivering = true;
          queueMicrotask(place);
        }
        return measureRow(element, entry, instance);
      },
      onChange() {
        if (delivering) moved = true;
      },
    };
  });
  return options;
}
