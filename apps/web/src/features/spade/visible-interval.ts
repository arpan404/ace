import { documentVisibility, type PageVisibility } from "@/lib/page-visibility.ts";

/** Starts a repeating timer; returns what stops it. */
export type Repeat = (callback: () => void, everyMs: number) => () => void;
const intervals: Repeat = (callback, everyMs) => {
  const timer = setInterval(callback, everyMs);
  return () => clearInterval(timer);
};

/**
 * Run `look` every `everyMs` while the page is on screen: the timer stops while it is hidden
 * (a hidden window does no work) and `look` runs once as soon as it is shown again, so what it
 * keeps is caught up before the person reads it. Returns what stops it.
 */
export function visibleInterval(
  look: () => void,
  everyMs: number,
  page: PageVisibility = documentVisibility,
  repeat: Repeat = intervals,
): () => void {
  let stop: (() => void) | undefined;
  const sync = () => {
    if (!page.visible()) {
      stop?.();
      stop = undefined;
      return;
    }
    if (stop) return;
    stop = repeat(look, everyMs);
  };
  sync();
  const unwatch = page.watch(() => {
    const wasRunning = stop !== undefined;
    sync();
    if (!wasRunning && stop) look();
  });
  return () => {
    unwatch();
    stop?.();
    stop = undefined;
  };
}
