import { z } from "zod";
import { requireSnapshotVersion } from "./schema-version.ts";
import type { AgentRecord, ThreadState } from "@ace/core";
import {
  Agent,
  AgentActivity,
  AgentFidelity,
  AgentStatus,
  BackgroundTask,
  Interaction,
  Item,
  NativeRef,
  ProviderKind,
  RawPayload,
  Run,
  RunId,
  ThreadId,
  ThreadStatus,
  Timestamp,
} from "@ace/protocol";

const records = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema);
const keys = records(z.literal(true));
const error = z.object({
  kind: z.enum(["provider", "auth", "quota", "network", "process_exit", "unknown"]),
  message: z.string(),
});
const root = z.object({
  agent: z.string(),
  fidelity: AgentFidelity,
  native: NativeRef,
  cwd: z.string(),
  name: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  background: z.boolean().optional(),
});
const record = z.object({
  agent: Agent,
  activity: AgentActivity,
  lastSignalAt: Timestamp,
  activeRun: RunId.optional(),
  lastRun: RunId.optional(),
  nativeRuns: records(RunId).optional(),
  lastOutcomeOrder: Timestamp.optional(),
  lastSuccessfulOutcomeOrder: Timestamp.optional(),
  lastError: error.optional(),
  processSettledStatus: AgentStatus.refine(
    (status) => status.state === "failed" || status.state === "interrupted",
  ).optional(),
  detail: z.string().optional(),
  wakeUntil: Timestamp.optional(),
  parentKey: z.string().optional(),
  spawnedByKey: z.string().optional(),
  limited: z.object({ until: Timestamp.optional(), message: z.string().optional() }).optional(),
  retry: z
    .object({
      on: z.enum(["rate_limit", "network", "upstream"]),
      attempt: z.number().optional(),
      until: Timestamp.optional(),
      message: z.string().optional(),
    })
    .optional(),
});
const itemLinks = z.object({
  childAgent: z.string().optional(),
  targetAgent: z.string().optional(),
});
export const recordSchemas = {
  agents: z.custom<AgentRecord>((value) => record.safeParse(value).success),
  items: Item,
  runs: Run,
  interactions: Interaction,
  tasks: BackgroundTask,
  itemLinks: z.custom<ThreadState["itemLinks"][string]>(
    (value) => itemLinks.safeParse(value).success,
  ),
  keys: z.literal(true),
  key: z.string(),
  keySet: keys,
};
const snapshot = z.object({
  threadId: ThreadId,
  config: z.object({
    provider: ProviderKind,
    silenceMs: Timestamp,
    liveness: z.enum(["agent", "transport"]).optional(),
  }),
  rootKey: z.string().optional(),
  initialRoot: root.optional(),
  processExit: z
    .object({
      deliberate: z.boolean(),
      message: z.string().optional(),
      unsettled: z.array(z.string()).optional(),
    })
    .optional(),
  lastTransportSignalAt: Timestamp.optional(),
  agents: records(record),
  runs: records(Run),
  items: records(Item),
  interactions: records(Interaction),
  tasks: records(BackgroundTask),
  interactionHistory: records(Interaction),
  taskHistory: records(BackgroundTask),
  indexes: z.object({
    liveTools: keys,
    pendingInteractions: keys,
    runningTasks: keys,
    agentKeysById: records(z.string()),
    childrenByParent: records(keys),
    pendingSpawnLinks: records(keys),
    pendingItemLinks: keys,
  }),
  outcomeOrder: Timestamp,
  pendingNotices: z.array(
    z.object({ createdAt: Timestamp, text: z.string(), raw: z.array(RawPayload) }),
  ),
  itemLinks: records(itemLinks),
  queueCount: Timestamp,
  queueSources: z.object({ engine: Timestamp, provider: Timestamp }),
  hasRun: z.boolean(),
  status: ThreadStatus,
});

/** Validate without stripping fields, including raw provider data and future additions. */
const savedState = z.custom<ThreadState>(
  (value) => snapshot.safeParse(value).success,
  "Invalid saved core state",
);
export function decodeSnapshot(json: string): ThreadState {
  const value: unknown = JSON.parse(json);
  requireSnapshotVersion(value);
  return savedState.parse(value);
}
