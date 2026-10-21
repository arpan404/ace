/** How long a frame may take before the timer runs the work anyway. */
const frameFallbackMs = 100;

/**
 * Run before the next paint, or on a timer when no paint comes: a hidden tab, or a window the
 * browser stops painting while it still reports itself visible (Safari on another Space, an
 * occluded window). Whichever fires first runs the work, once.
 */
export function nextFrame(callback: () => void): () => void {
  let frame: number | undefined;
  let finished = false;
  const doc = globalThis.document;
  const cancel = () => {
    finished = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
  const run = () => {
    if (finished) return;
    cancel();
    callback();
  };
  const timer = setTimeout(run, frameFallbackMs);
  if (typeof requestAnimationFrame === "function" && !doc?.hidden)
    frame = requestAnimationFrame(run);
  return cancel;
}
