import type { BackgroundTask } from "@ace/protocol";

type HoldFacts = Pick<BackgroundTask, "ambient" | "wakesAgent" | "listening">;

/**
 * Whether live background work (running, or lost track of while still awaiting proof that it
 * ended) holds its thread open (ADR 0004, amended by ADR 0109).
 *
 * While its agent works, all of it does, and so after a turn that was stopped or failed. Once
 * the agent's turn finished on its own (a final reply), work holds only while the agent may
 * still come back for it, that is when the provider resumes the agent as it ends. Two facts say
 * it won't, and either one releases the hold:
 *
 * - `wakesAgent: false`: the provider reported it never resumes the agent for this task;
 * - `listening`: its processes listen on a port, a service left running for the person rather
 *   than a result the agent waits for.
 *
 * Released work still runs: it is listed as left running, stoppable, and is cleaned up with the
 * provider process when the thread is settled or archived. Pure.
 */
export function holdsThread(task: HoldFacts, turnFinished: boolean): boolean {
  if (task.ambient) return false;
  if (!turnFinished) return true;
  return task.wakesAgent !== false && !task.listening?.length;
}

/** Running work the thread no longer waits for: shown as left running, never hidden. */
export function leftRunning(
  task: HoldFacts & Pick<BackgroundTask, "status">,
  turnFinished: boolean,
): boolean {
  return task.status === "running" && !task.ambient && !holdsThread(task, turnFinished);
}
