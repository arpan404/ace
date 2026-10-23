import { useEffect, useRef, useState } from "react";

/**
 * How long typing pauses before a search goes out. `#` asks GitHub two searches at once, and
 * GitHub limits how fast searches may come, so a keystroke alone never sends one.
 */
export const searchDelayMs = 200;

/**
 * The answer to the latest search, by its key: `run` goes out once `key` has held still for
 * `searchDelayMs`, and a newer key cancels a search still waiting or on its way. Until the new
 * answer comes, the last one stays, with the key it answers, so callers decide whether it
 * still fits. No key, no search. A failed search answers `undefined`.
 */
export function useSearch<T>(
  key: string | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): { key: string; value: T | undefined } | undefined {
  const [answer, setAnswer] = useState<{ key: string; value: T | undefined }>();
  // The latest `run`: callers build it each render, and only a new key starts a search.
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      latest.current(controller.signal).then(
        (value) => !controller.signal.aborted && setAnswer({ key, value }),
        () => !controller.signal.aborted && setAnswer({ key, value: undefined }),
      );
    }, searchDelayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return answer;
}
