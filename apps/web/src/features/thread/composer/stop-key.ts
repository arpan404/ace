import { useEffect, useState } from "react";

/** How soon after the first Esc a second one stops the agent tree. */
export const stopKeyWindowMs = 1_500;

/**
 * Esc in the composer while an agent works: the first press only arms (the strip says "Esc again
 * to stop"), a second within `stopKeyWindowMs` stops. Arming lapses on its own, and whenever there
 * is nothing left to stop.
 */
export function useStopKey(canStop: boolean, stop: () => void) {
  const [armedAt, setArmedAt] = useState<number>();
  const armed = canStop && armedAt !== undefined;
  useEffect(() => {
    if (!canStop || armedAt === undefined) return;
    const expire = setTimeout(() => setArmedAt(undefined), stopKeyWindowMs);
    return () => clearTimeout(expire);
  }, [canStop, armedAt]);
  const stopKey = (at: number) => {
    const again =
      armed && armedAt !== undefined && at >= armedAt && at - armedAt <= stopKeyWindowMs;
    setArmedAt(again ? undefined : at);
    if (again) stop();
  };
  return { armed, stopKey };
}
