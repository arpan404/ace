import type { ThreadReader } from "@ace/client";
import { RunId } from "@ace/protocol";
import type { StopFence } from "@ace/ui-core";

/**
 * What a Stop for one agent names, read when it is pressed: the agent's active run, so the
 * daemon refuses it (`stale_interrupt`) once that run is over and never stops a later one; or,
 * while no run of its is known, the transcript cursor, so a run started after it is refused
 * too. Undefined only before the thread has loaded at all. Pure.
 */
export function agentStopFence(reader: ThreadReader, agentId: string): StopFence | undefined {
  for (const id of reader.runIds?.() ?? []) {
    const run = reader.run(id);
    if (run?.agentId === agentId && run.state === "active") return { runId: RunId.parse(id) };
  }
  return reader.cursor === undefined ? undefined : { beforeSeq: reader.cursor };
}
