import type { Thread } from "../../types";

export const ACTIVE_THREAD_HYDRATION_FALLBACK_DELAY_MS = 500;

export function shouldHydrateActiveThreadFromReadModelFallback(
  thread: Pick<Thread, "historyLoaded" | "latestTurn" | "session"> | undefined,
): thread is Pick<Thread, "historyLoaded" | "latestTurn" | "session"> {
  return Boolean(
    thread &&
    thread.historyLoaded === false &&
    thread.latestTurn?.state !== "running" &&
    thread.session?.orchestrationStatus !== "running" &&
    thread.session?.status !== "running",
  );
}
