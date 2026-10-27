import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { latestForkPoint, sameForkPoint } from "@ace/ui-core";

const read = (reader: ThreadReader) => latestForkPoint(reader, reader.thread?.rootAgentId);

/**
 * Where "Fork from the last turn" starts: the main agent's newest finished answer. Undefined
 * until a turn has finished. A finished turn moves the thread's status, so `thread` covers it.
 */
export function useLatestForkPoint(threadId: string): ForkPoint | undefined {
  return useThread(threadId, ["thread", "order"], read, sameForkPoint);
}
