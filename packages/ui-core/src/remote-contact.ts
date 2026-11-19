import type { Agent, BackgroundTask } from "@ace/protocol";

/*
 * Words for a child on another machine that this machine can't vouch for (ADR 0052, "Stop and
 * proof of life"). Plain words, no new chrome: the row's step says it.
 */

/** The step a remote child's row shows when its contact is in doubt; undefined otherwise. */
export function remoteContactStep(agent: Pick<Agent, "machine">): string | undefined {
  switch (agent.machine?.contact) {
    case "lost":
      return "lost contact · resumes if it reports";
    case "unconfirmed":
      return "stopped · didn't confirm";
    default:
      return undefined;
  }
}

/**
 * Whether the person can still stop the work a parent holds: while it runs, and while it lost
 * contact (Stop then ends it here for good and asks its machine to stop it).
 */
export const holdStoppable = (task: Pick<BackgroundTask, "status" | "stoppable">) =>
  task.stoppable && (task.status === "running" || task.status === "unknown");
