import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useReducedMotion } from "./motion.ts";

/*
 * "New" for lists that are not virtualized (the Activity feed, the agent tree): a row that
 * mounts after its list first painted arrived while the person was looking, so it rises in.
 * Rows present on first paint just appear. Virtualized lists use `useListMotion` instead,
 * because their rows also mount when scrolled into view.
 */
const ArrivalContext = createContext<() => boolean>(() => false);

export function ArrivalScope(props: { children: ReactNode }) {
  const painted = useRef(false);
  useEffect(() => {
    painted.current = true;
    return () => {
      painted.current = false;
    };
  }, []);
  const read = useCallback(() => painted.current, []);
  return <ArrivalContext.Provider value={read}>{props.children}</ArrivalContext.Provider>;
}

/** The entrance class for a row of an `ArrivalScope`, or nothing if it was there all along. */
export function useArrival(): string | undefined {
  const painted = useContext(ArrivalContext);
  const reduced = useReducedMotion();
  const [arrived] = useState(painted);
  return arrived && !reduced ? "fx-rise-in" : undefined;
}
