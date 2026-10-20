import type { Scheduler } from "./registry.ts";

/** How often a long call reports that it is still running. */
export const progressIntervalMs = 30_000;

type ProgressNotification = {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; message: string };
};

/**
 * Keeps a long call (a wait on children, a slow merge) visibly alive for a client that asked for
 * progress. Claude Code aborts an MCP call that sends no response or progress for 300 s and
 * records it as failed, so a `wait` of 300 s or more would end as a failed call while its
 * children were still fine. Returns the function that stops the beats once the call settles.
 */
export function progressHeartbeat(
  token: string | number | undefined,
  notify: (notification: ProgressNotification) => Promise<void>,
  scheduler: Scheduler,
): () => void {
  if (token === undefined) return () => {};
  const progressToken = token;
  let progress = 0;
  let stopped = false;
  let cancel = scheduler.after(progressIntervalMs, beat);
  function beat(): void {
    if (stopped) return;
    progress++;
    notify({
      method: "notifications/progress",
      params: { progressToken, progress, message: "Still running" },
    }).catch(() => {
      /* A client that went away needs no beat. */
    });
    cancel = scheduler.after(progressIntervalMs, beat);
  }
  return () => {
    stopped = true;
    cancel();
  };
}
