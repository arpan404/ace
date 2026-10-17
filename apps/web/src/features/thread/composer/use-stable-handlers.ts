import { useLayoutEffect, useRef, useState } from "react";

type Handlers = Record<string, (...args: never[]) => unknown>;

/**
 * Event handlers with one identity for the component's life that always run the latest
 * render's version, so a memoised child they're passed to never re-renders for them. Call them
 * from events only, never during render.
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const [stable] = useState(() => {
    const wrapped: Handlers = {};
    for (const name of Object.keys(handlers))
      wrapped[name] = (...args: never[]) => latest.current[name]?.(...args);
    return wrapped as T;
  });
  return stable;
}
