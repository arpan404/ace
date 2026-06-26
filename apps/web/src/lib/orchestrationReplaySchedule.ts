export const ACTIVE_THREAD_REPLAY_INTERVAL_MS = 1_500;
export const IDLE_THREAD_REPLAY_INTERVAL_MS = 15_000;

export function resolveThreadReplayDelayMs(input: {
  readonly isThreadActive: boolean;
  readonly visibilityState: DocumentVisibilityState | "unsupported";
}): number | null {
  if (input.visibilityState === "hidden") {
    return null;
  }
  return input.isThreadActive ? ACTIVE_THREAD_REPLAY_INTERVAL_MS : IDLE_THREAD_REPLAY_INTERVAL_MS;
}
