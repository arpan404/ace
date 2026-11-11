import type { BackgroundTask } from "@ace/protocol";

type HoldFacts = Pick<BackgroundTask, "ambient" | "kind" | "internal" | "blocksPrompts">;

/** Work an agent leaves running after its final reply that no longer keeps the thread open. */
const releasedKinds = new Set<BackgroundTask["kind"]>(["shell", "monitor"]);

/**
 * Whether live background work (running, or lost track of while still awaiting proof that it
 * ended) holds its thread open (ADR 0004, amended by ADR 0109 and ADR 0116).
 *
 * While its agent works, all of it does, and so after a turn that was stopped or failed.
 * `replied`: its agent and the thread's main agent both finished their turns on their own. The
 * final reply is then the result: commands and
 * monitors it left running (builds, tests, watch loops, servers) no longer hold the thread. If
 * the provider later wakes the agent for one, that is a new turn, and its parent hears it as an
 * update. Three kinds of work still hold after a finished turn:
 *
 * - ace's own bookkeeping (`internal`);
 * - a background subagent: an agent of the tree still at work;
 * - work the provider takes no new prompt beside (`blocksPrompts`, an ACP shell): reading done
 *   would show a thread that refuses the next message.
 *
 * Released work still runs: it is listed as left running, stoppable, and is cleaned up with the
 * provider process when the thread is settled or archived. Pure.
 */
export function holdsThread(task: HoldFacts, replied: boolean): boolean {
  if (task.ambient) return false;
  if (!replied) return true;
  return task.internal === true || task.blocksPrompts === true || !releasedKinds.has(task.kind);
}

/** Running work the thread no longer waits for: shown as left running, never hidden. */
export function leftRunning(
  task: HoldFacts & Pick<BackgroundTask, "status">,
  replied: boolean,
): boolean {
  return task.status === "running" && !task.ambient && !holdsThread(task, replied);
}
