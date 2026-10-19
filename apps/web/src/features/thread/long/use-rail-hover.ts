import { useEffect, useMemo, useRef, useState } from "react";
import { restingHover, stepRailHover, type RailHover, type RailHoverEvent } from "./rail-hover.ts";
import { browserTime, type RailHighlightTime } from "./use-rail-highlight.ts";

/**
 * The rail's hovered tick and open preview card, run on `time`'s timers. Each event cancels the
 * timer the last one started; the component re-renders only when the hovered or shown tick changes.
 */
export function useRailHover(
  time: RailHighlightTime = browserTime,
): [RailHover, (event: RailHoverEvent) => void] {
  const [hover, setHover] = useState(restingHover);
  const state = useRef(restingHover);
  const cancel = useRef<(() => void) | undefined>(undefined);
  const dispatch = useMemo(() => {
    function send(event: RailHoverEvent): void {
      const step = stepRailHover(state.current, event);
      cancel.current?.();
      cancel.current = undefined;
      const before = state.current;
      if (step.state.hovered !== before.hovered || step.state.shown !== before.shown) {
        state.current = step.state;
        setHover(step.state);
      }
      const wait = step.wait;
      if (!wait) return;
      cancel.current = time.after(wait.ms, () => {
        cancel.current = undefined;
        send(wait.fire);
      });
    }
    return send;
  }, [time]);
  useEffect(
    () => () => {
      cancel.current?.();
      cancel.current = undefined;
    },
    [time],
  );
  return [hover, dispatch];
}
