/**
 * Runs `task` when the browser is idle (or after `fallbackMs` where `requestIdleCallback` is
 * missing, as in Safari and jsdom). Returns a cancel function. For warming code the first paint
 * left out, so it is ready before anyone needs it.
 */
export function whenIdle(task: () => void, fallbackMs = 2_000): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(task);
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(task, fallbackMs);
  return () => clearTimeout(timer);
}
