import type { Thread } from "../../types";

export const ACTIVE_THREAD_HYDRATION_FALLBACK_DELAY_MS = 500;

type ThreadLiveWorkState = Pick<Thread, "latestTurn" | "session">;

export function isThreadLiveWorkActive(thread: ThreadLiveWorkState | undefined): boolean {
  return Boolean(
    thread &&
    (thread.latestTurn?.state === "running" ||
      thread.session?.orchestrationStatus === "running" ||
      thread.session?.status === "running"),
  );
}

export function shouldHydrateActiveThreadFromReadModelFallback(
  thread: Pick<Thread, "historyLoaded" | "latestTurn" | "session"> | undefined,
): thread is Pick<Thread, "historyLoaded" | "latestTurn" | "session"> {
  return Boolean(thread && thread.historyLoaded === false && !isThreadLiveWorkActive(thread));
}
