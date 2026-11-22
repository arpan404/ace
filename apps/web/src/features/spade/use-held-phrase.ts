import { spadeHoldPhrase, type SpadeHeldPhrase } from "@ace/ui-core/spade-chat";
import { useEffect, useState } from "react";
import { useWallClock } from "@/lib/time.ts";

/**
 * The Working line's phrase as shown: `next` takes the place of the one up only once that has
 * been read for a moment (`spadeHoldPhrase`), so a fast run of steps never flickers.
 */
export function useHeldPhrase(next: string): string {
  const wall = useWallClock();
  const [held, setHeld] = useState<SpadeHeldPhrase>(() => ({ text: next, since: wall() }));
  useEffect(() => {
    const step = spadeHoldPhrase(held, next, wall());
    if (step.held === held && step.recheckIn === undefined) return;
    // The next phrase goes up once the one shown has had its moment (now, if it has).
    const timer = setTimeout(
      () => setHeld((shown) => spadeHoldPhrase(shown, next, wall()).held),
      step.held === held ? step.recheckIn : 0,
    );
    return () => clearTimeout(timer);
  }, [held, next, wall]);
  return held.text;
}
