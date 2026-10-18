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

/** `quietMs`: time from the last retirement to the request that started the worker again. */
export function nextIdleWindow(
  policy: IdleWindowPolicy,
  currentMs: number,
  quietMs: number,
): number {
  if (quietMs < currentMs * 4) return Math.min(policy.maxMs, currentMs * 2);
  return policy.baseMs;
}
