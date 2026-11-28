import type { ThreadReader } from "@ace/client";
import type { Run } from "@ace/protocol";

export type SteerHandoverReader = Pick<
  ThreadReader,
  "order" | "item" | "run" | "agent" | "thread" | "queue"
>;

/** How many newest items are searched for the root's last run: bounded, never history-sized. */
const lookBack = 64;

/**
 * The root's newest run, from the newest items that belong to one. The steer itself sits newest
 * with no run yet, so the run it cancelled is found just behind it.
 */
function newestRootRun(reader: SteerHandoverReader, rootId: string): Run | undefined {
  const { order } = reader;
  for (let index = order.length - 1; index >= 0 && index >= order.length - lookBack; index--) {
    const runId = reader.item(order[index] ?? "")?.runId;
    const run = runId ? reader.run(runId) : undefined;
    if (run?.agentId === rootId) return run;
  }
  return undefined;
}

/**
 * Whether the root's turn ended only to make way for the person's steer, which goes in next.
 * Where ace steers by cancelling the turn (ACP agents that can't take a message mid-turn), the
 * cancelled run ends interrupted, marked `endedBy: "steer"`, and the steer's own turn starts a
 * moment later. In between the root reads interrupted and the thread waits on its queue, which
 * the person would otherwise see as a stop.
 *
 * Read from facts the daemon already sends, and only for what the person sees: the engine never
 * reads it, so it can't hold up a switch or a send. It holds only while the queue will send by
 * itself (not paused, not held on a failed send); a Stop, a refusal or a removed message changes
 * those facts, and it stops holding on its own.
 */
export function steerHandingOver(reader: SteerHandoverReader, rootId: string): boolean {
  const status = reader.thread?.status;
  if (status?.state !== "waiting" || status.on !== "queue") return false;
  const queue = reader.queue;
  if (!queue || queue.paused || queue.lastFailure) return false;
  if (reader.agent(rootId)?.status.state !== "interrupted") return false;
  const run = newestRootRun(reader, rootId);
  return run?.state === "interrupted" && run.endedBy === "steer";
}
