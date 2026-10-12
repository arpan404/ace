import type { ThreadReader } from "@ace/client";
import { RunId } from "@ace/protocol";

/** Authoritative root ownership survives bounded transcript and worker snapshots. */
export function activeRootRun(reader: ThreadReader): string | undefined {
  const live = reader.thread?.live?.rootRunId;
  if (live !== undefined) return live ?? undefined;
  // Compatibility with older daemons; the cursor still fences an unknown startup.
  const root = reader.thread?.rootAgentId;
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const runId = reader.item(reader.order[index] ?? "")?.runId;
    if (!runId) continue;
    const run = reader.run(runId);
    if (run && run.agentId === root) return run.state === "active" ? runId : undefined;
  }
  return undefined;
}

export type StopFence = { runId: RunId } | { beforeSeq: number };
/** An unknown pre-run target never becomes an unbounded offline Stop. */
export function stopFence(reader: ThreadReader): StopFence | undefined {
  const run = activeRootRun(reader);
  if (run) return { runId: RunId.parse(run) };
  return reader.cursor === undefined ? undefined : { beforeSeq: reader.cursor };
}
