import type { Item, ThreadListEntry, ThreadView } from "@ace/protocol";
import type { ClientError } from "./errors.ts";

/** Change keys of a thread store; a selector lists every key it reads. */
export type ThreadKey =
  | "error"
  | "thread"
  | "order"
  | "cursor"
  | "history"
  | "agents"
  | "interactions"
  | "tasks"
  | `item:${string}`
  | `agent:${string}`
  | `run:${string}`
  | `interaction:${string}`
  | `task:${string}`
  | `usage:${string}`
  | `usageSnapshot:${string}`;
export interface ThreadReader {
  readonly error: ClientError | undefined;
  readonly thread: ThreadView["thread"] | undefined;
  readonly order: readonly string[];
  readonly cursor: number | undefined;
  readonly itemsBefore: number | null | undefined;
  /** Fresh membership lists: select with the "agents", "interactions" or "tasks" key and
   * an array equality, because each call returns a new array. */
  agentIds(): readonly string[];
  children(agentId: string): readonly string[];
  interactionIds(): readonly string[];
  taskIds(): readonly string[];
  item(id: string): Item | undefined;
  agent(id: string): ThreadView["agents"][string] | undefined;
  run(id: string): ThreadView["runs"][string] | undefined;
  interaction(id: string): ThreadView["interactions"][string] | undefined;
  task(id: string): ThreadView["backgroundTasks"][string] | undefined;
  usage(id: string): ThreadView["usage"][string] | undefined;
  usageSnapshot(key: string): ThreadView["usageSnapshots"][string] | undefined;
  truncated(id: string): boolean;
}
/** Change keys of the thread list. */
export type SidebarKey = "error" | "ids" | `thread:${string}`;
export interface SidebarReader {
  readonly error: ClientError | undefined;
  readonly ids: readonly string[];
  thread(id: string): ThreadListEntry | undefined;
}
