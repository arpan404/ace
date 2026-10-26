/** Runs `run` after `ms` on a timer; the result cancels it. */
export function later(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}
