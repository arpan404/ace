import type {
  Agent,
  AgentActivity,
  AgentStatus,
  BackgroundTask,
  Interaction,
  Item,
  Run,
  RunId,
  ProviderKind,
  RawPayload,
  ThreadId,
  ThreadStatus,
} from "@ace/protocol";
import { ProviderKind as ProviderKindSchema } from "@ace/protocol";
import type { AgentError, Fact, Key, RootAgentInit } from "./facts.ts";
export { get as lookup, put } from "./emit.ts";

export interface CoreConfig {
  /** Provider used for placeholders before an explicit root arrives. */
  provider: ProviderKind;
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
  externalStatus?: ThreadStatus;
  activeRun?: RunId;
  lastRun?: RunId;
  /** Process-namespaced native turn ids index the canonical run history. */
  nativeRuns?: Record<string, RunId>;
  lastOutcomeOrder?: number;
  lastSuccessfulOutcomeOrder?: number;
  lastError?: AgentError;
  processSettledStatus?: Extract<AgentStatus, { state: "failed" | "interrupted" }>;
  activity: AgentActivity;
  detail?: string;
  lastSignalAt: number;
  disconnectedAt?: number;
  retry?: Omit<Extract<Fact, { type: "retry" }>, "type" | "agent">;
  wakeUntil?: number;
  parentKey?: Key;
  spawnedByKey?: Key;
}

export interface LiveIndexes {
  liveTools: Record<Key, true>;
  pendingInteractions: Record<Key, true>;
  runningTasks: Record<Key, true>;
  agentKeysById: Record<string, Key>;
  childrenByParent: Record<string, Record<Key, true>>;
  pendingSpawnLinks: Record<Key, Record<Key, true>>;
  pendingItemLinks: Record<Key, true>;
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
  /** Optional for snapshots created before uncertain execution was represented. */
  uncertainTasks?: Record<Key, true>;
  interactionHistory: Record<string, Interaction>;
  taskHistory: Record<string, BackgroundTask>;
  indexes: LiveIndexes;
  outcomeOrder: number;
  /** Rejected facts wait for a real fact to establish their root owner. */
  pendingNotices: { createdAt: number; text: string; raw: RawPayload[] }[];
  itemLinks: Record<Key, { childAgent?: Key; targetAgent?: Key; waitingFor?: Key[] }>;
  queueCount: number;
  queueSources: { engine: number; provider: number };
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
  ProviderKindSchema.parse(init.config.provider);
  if (
    init.config.liveness !== undefined &&
    !["agent", "transport"].includes(init.config.liveness)
  ) {
    throw new Error("liveness must be agent or transport");
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
    uncertainTasks: dictionary(),
    interactionHistory: dictionary(),
    taskHistory: dictionary(),
    indexes: {
      liveTools: dictionary(),
      pendingInteractions: dictionary(),
      runningTasks: dictionary(),
      agentKeysById: dictionary(),
      childrenByParent: dictionary(),
      pendingSpawnLinks: dictionary(),
      pendingItemLinks: dictionary(),
    },
    outcomeOrder: 0,
    pendingNotices: [],
    itemLinks: dictionary(),
    queueCount: 0,
    queueSources: { engine: 0, provider: 0 },
    hasRun: false,
    status: { state: "new" },
  };
}
