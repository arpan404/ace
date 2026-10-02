import type {
  Agent,
  AgentActivity,
  BackgroundTask,
  Interaction,
  Item,
  Run,
  RunId,
  ThreadId,
  ThreadStatus,
} from "@ace/protocol";
import type { AgentError, Fact, Key, RootAgentInit } from "./facts.ts";
export { get as lookup, put } from "./emit.ts";

export interface CoreConfig {
  /** Silence threshold, evaluated according to the configured liveness source. */
  silenceMs: number;
  /** Defaults to agent silence. Transport mode also watches tools and retries. */
  liveness?: "agent" | "transport";
}

export interface IdSource {
  next(kind: "agent" | "run" | "item" | "interaction" | "task"): string;
}

export interface ApplyContext {
  now: number;
  ids: IdSource;
}

export interface AgentRecord {
  agent: Agent;
  activeRun?: RunId;
  lastRun?: RunId;
  lastError?: AgentError;
  activity: AgentActivity;
  detail?: string;
  lastSignalAt: number;
  retry?: Omit<Extract<Fact, { type: "retry" }>, "type" | "agent">;
  wakeUntil?: number;
  parentKey?: Key;
  spawnedByKey?: Key;
}

export interface ThreadState {
  threadId: ThreadId;
  config: CoreConfig;
  rootKey?: Key;
  /** Consumed on first apply, so initialization needs neither time nor ids. */
  initialRoot?: RootAgentInit;
  processExit?: { deliberate: boolean; message?: string; unsettled?: Key[] };
  lastTransportSignalAt?: number;
  agents: Record<Key, AgentRecord>;
  runs: Record<string, Run>;
  items: Record<Key, Item>;
  interactions: Record<Key, Interaction>;
  tasks: Record<Key, BackgroundTask>;
  itemLinks: Record<Key, { childAgent?: Key; targetAgent?: Key }>;
  queueCount: number;
  hasRun: boolean;
  status: ThreadStatus;
}

export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function createThreadState(init: {
  threadId: ThreadId;
  rootAgent?: RootAgentInit;
  config: CoreConfig;
}): ThreadState {
  if (!Number.isFinite(init.config.silenceMs) || init.config.silenceMs < 0) {
    throw new Error("silenceMs must be finite and nonnegative");
  }
  return {
    threadId: init.threadId,
    config: { ...init.config },
    ...(init.rootAgent ? { initialRoot: structuredClone(init.rootAgent) } : {}),
    agents: dictionary(),
    runs: dictionary(),
    items: dictionary(),
    interactions: dictionary(),
    tasks: dictionary(),
    itemLinks: dictionary(),
    queueCount: 0,
    hasRun: false,
    status: { state: "new" },
  };
}
