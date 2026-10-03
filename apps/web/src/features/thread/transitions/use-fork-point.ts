import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ForkPoint } from "@ace/protocol";
import { latestForkPoint } from "./fork-point.ts";

const read = (reader: ThreadReader) => latestForkPoint(reader, reader.thread?.rootAgentId);
const same = (a: ForkPoint | undefined, b: ForkPoint | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Where "Fork from the last turn" starts: the main agent's newest finished answer. Undefined
 * until a turn has finished. A finished turn moves the thread's status, so `thread` covers it.
 */
export function useLatestForkPoint(threadId: string): ForkPoint | undefined {
  return useThread(threadId, ["thread", "order"], read, same);
}
