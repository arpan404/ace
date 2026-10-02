/**
 * Fire `interrupt` once, `delayMs` after the first call to the returned
 * trigger. Used by scenarios that interrupt mid-tool.
 */
export function interruptOnce(delayMs: number | undefined, interrupt: () => void): () => void {
  let armed = delayMs !== undefined;
  return () => {
    if (!armed) return;
    armed = false;
    setTimeout(interrupt, delayMs);
  };
}
