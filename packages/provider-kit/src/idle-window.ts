/**
 * How long an idle worker isolate stays alive after its last reply.
 *
 * Retiring frees the isolate's memory, but a cold start costs ~100 ms of CPU, reloads its
 * modules and reopens its database. A worker that is woken again soon after it retired paid
 * that cost for nothing, so its window doubles, up to the cap. One that stays retired well
 * past its window goes back to the base, so rarely used workers still release memory.
 */
export interface IdleWindowPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Once the first short idle window has elapsed, allow enough time for periodic callers to
 * demonstrate that the restart was wasteful. The cutoff is still finite: long quiet stretches
 * return the worker to its base window and release its isolate.
 */
const REUSE_WINDOW_MULTIPLIER = 12;

/** `quietMs`: time from the last retirement to the request that started the worker again. */
export function nextIdleWindow(
  policy: IdleWindowPolicy,
  currentMs: number,
  quietMs: number,
): number {
  const reuseThreshold = Math.max(policy.baseMs * REUSE_WINDOW_MULTIPLIER, currentMs * 4);
  if (quietMs >= 0 && quietMs < reuseThreshold) return Math.min(policy.maxMs, currentMs * 2);
  return policy.baseMs;
}
