import type { ThreadKey, ThreadReader } from "@ace/client";
import { useItemOrder, useThread } from "@ace/client-react";
import { useCallback, useMemo } from "react";

/** How far back to look for the browser call; drivers are recent by nature. */
const recent = 200;

/**
 * Who is driving the thread's browser (its agent id), from the thread's own agent tree: the
 * agent with a browser tool call still running, else the root agent. The browser service only
 * knows a connection id for its controller, never an agent, so who it is comes from here.
 */
export function useBrowserDriver(threadId: string): string | undefined {
  const read = useCallback((reader: ThreadReader) => {
    const order = reader.order;
    for (let index = order.length - 1; index >= Math.max(0, order.length - recent); index--) {
      const item = reader.item(order[index] ?? "");
      if (item?.type !== "tool_call" || item.call.kind !== "browser") continue;
      if (item.call.status !== "running") continue;
      if (reader.agent(item.call.agentId)) return item.call.agentId;
    }
    const rootId = reader.thread?.rootAgentId;
    return rootId && reader.agent(rootId) ? rootId : undefined;
  }, []);
  const order = useItemOrder(threadId);
  // Re-read when a recent item changes (a browser call starting or finishing), not on any delta.
  const keys = useMemo<ThreadKey[]>(
    () => [
      "order",
      "agents",
      "thread",
      ...(order ?? []).slice(-recent).map((id): ThreadKey => `item:${id}`),
    ],
    [order],
  );
  return useThread(threadId, keys, read);
}
