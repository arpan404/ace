/**
 * Seconds left of a wait the agent asked for when its call began. A delegation creates its
 * children first; counting the wait from the call's start keeps the whole call inside the time
 * the agent (and a client that cancels long calls, such as Cursor) allowed. Never below one
 * second, the smallest wait the monitor takes, so ready children are still reported.
 */
export function remainingWaitSeconds(seconds: number, startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt);
  return Math.max(1, Math.floor((seconds * 1000 - elapsed) / 1000));
}
