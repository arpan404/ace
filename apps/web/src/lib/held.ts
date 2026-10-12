import { useEffect, useState } from "react";

/**
 * How long a loading or syncing state must last before it shows. Most finish sooner, and a
 * state that flashes for a frame reads as a glitch, not as progress.
 */
export const statusDelayMs = 350;

/** True once `active` has held for `ms`; false again as soon as it ends. */
export function useHeld(active: boolean, ms = statusDelayMs): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [active, ms]);
  return active && held;
}
