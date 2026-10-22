import type { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";

const AgentRow = z.object({ id: z.string(), parent: z.string().nullable() });

/** Agent `agentId` of the thread and every native agent below it, by their parent links. */
export function agentSubtree(store: Store, thread: ThreadId, agentId: string): Set<string> {
  const below = new Map<string, string[]>();
  for (const row of store
    .statement(
      "SELECT id,json_extract(value,'$.parentId') AS parent FROM view_entities WHERE thread_id=? AND collection='agents'",
    )
    .all(thread)) {
    const agent = AgentRow.parse(row);
    if (agent.parent === null) continue;
    below.set(agent.parent, [...(below.get(agent.parent) ?? []), agent.id]);
  }
  const found = new Set<string>([agentId]);
  for (const id of found) for (const child of below.get(id) ?? []) found.add(child);
  return found;
}
