import type { McpAttribution } from "@ace/protocol";
import type { Store } from "../store.ts";

export function callerThread(store: Store, caller: McpAttribution) {
  const thread = store.getThread(caller.threadId);
  if (!thread || !store.getMcpAgent(caller.threadId, caller.agentId))
    throw new Error("Forbidden caller");
  return thread;
}
