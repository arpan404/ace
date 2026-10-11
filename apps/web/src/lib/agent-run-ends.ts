import type { ThreadReader } from "@ace/client";
import type { Watched } from "./use-watched.ts";

/** Providers finish reusable agents' runs without ending the agent entity. One pass for any number of agents. */
export function agentRunEnds(
  reader: ThreadReader,
  agents: ReadonlySet<string>,
): Watched<ReadonlyMap<string, number>> {
  const ends = new Map<string, number>();
  const runs = new Set<string>();
  for (const itemId of reader.order) {
    const item = reader.item(itemId);
    if (!item?.agentId || !agents.has(item.agentId) || !item.runId || runs.has(item.runId))
      continue;
    runs.add(item.runId);
    const ended = reader.run(item.runId)?.endedAt;
    if (ended !== undefined)
      ends.set(item.agentId, Math.max(ends.get(item.agentId) ?? ended, ended));
  }
  return { value: ends, watch: [...runs].map((run) => `run:${run}`) };
}
