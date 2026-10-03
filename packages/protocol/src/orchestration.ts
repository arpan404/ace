import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

export const OrchestrationId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  .refine((id) => !["__proto__", "constructor", "prototype"].includes(id))
  .meta({
    "x-ace-constraint": "Must not be __proto__, constructor or prototype.",
    not: { enum: ["__proto__", "constructor", "prototype"] },
  });
export const LaneId = OrchestrationId;
const text = z.string().max(8192);
const ref = z.string().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const LaneSpec = z.object({ provider: ProviderKind, model: ref });
export type LaneSpec = z.infer<typeof LaneSpec>;
export const OrchestrationChecks = z
  .object({
    command: z.array(z.string().max(4096)).min(1).max(64),
    review: text.optional(),
  })
  .refine(
    (c) => Boolean(c.command[0]) && c.command.every((arg) => !arg.includes("\0")),
    "Checks need an executable and NUL-free argv",
  )
  .meta({ "x-ace-constraint": "command[0] must be nonempty and every argument must be NUL-free." });
export const OrchestrationBudget = z.object({
  maxLanes: z.number().int().min(1).max(64),
  maxDepth: z.number().int().min(0).max(8),
  maxAttempts: z.number().int().min(1).max(10),
  durationMs: count.positive(),
  tokens: count.positive(),
  cost: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
});
export const OrchestrationTemplate = z
  .object({
    kind: z.enum(["fanout", "pipeline", "race", "coordinator"]),
    lanes: z.array(LaneSpec).min(1).max(64),
    checks: OrchestrationChecks,
    budget: OrchestrationBudget,
  })
  .refine(
    (t) =>
      t.lanes.length <= t.budget.maxLanes && (t.kind !== "coordinator" || t.lanes.length === 1),
    {
      message: "Initial lanes must fit the budget; coordinator needs one planner",
    },
  )
  .meta({
    "x-ace-constraint":
      "lanes.length must be <= budget.maxLanes; a coordinator must have exactly one lane.",
  });
export const OrchestrationCreate = z.object({
  workspaceId: WorkspaceId,
  prompt: z.string().min(1).max(32768),
  baseRef: ref.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Pin the base commit SHA"),
  targetBranch: ref,
  template: OrchestrationTemplate,
});
export type OrchestrationCreate = z.infer<typeof OrchestrationCreate>;
export const TestResults = z.object({ passed: count, failed: count, outputRef: ref.optional() });
export const OrchestrationArtifact = z.object({
  checkpoint: ref,
  summary: text,
  diffRef: ref.optional(),
  tests: TestResults,
});
export type OrchestrationArtifact = z.infer<typeof OrchestrationArtifact>;
export const OrchestrationUsage = z.object({
  tokens: count,
  cost: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const LanePhase = z.enum([
  "queued",
  "starting",
  "working",
  "waiting",
  "collecting",
  "checking",
  "joining",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
]);
export type LanePhase = z.infer<typeof LanePhase>;
export const OrchestrationLane = z.object({
  id: LaneId,
  spec: LaneSpec,
  prompt: z.string().min(1).max(33024),
  stage: count,
  depth: count.max(8),
  parentId: LaneId.optional(),
  threadId: ThreadId.optional(),
  worktree: ref.optional(),
  phase: LanePhase,
  attempt: count.min(1).max(10),
  startedAt: count,
  endedAt: count.optional(),
  threadDone: z.boolean(),
  children: count.max(64),
  failedChildren: count.max(64),
  usage: OrchestrationUsage,
  attemptUsage: OrchestrationUsage,
  artifact: OrchestrationArtifact.optional(),
  input: OrchestrationArtifact.optional(),
  checksPassed: z.boolean().optional(),
  error: text.optional(),
});
export type OrchestrationLane = z.infer<typeof OrchestrationLane>;
export const OrchestrationRunStatus = z.enum([
  "running",
  "waiting",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
export const OrchestrationEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("orchestration.lane"),
    orchestrationId: OrchestrationId,
    runId: OrchestrationId,
    laneId: LaneId,
    phase: LanePhase,
  }),
  z.object({
    type: z.literal("orchestration.status"),
    orchestrationId: OrchestrationId,
    runId: OrchestrationId,
    status: OrchestrationRunStatus,
  }),
  z.object({
    type: z.literal("orchestration.winner"),
    orchestrationId: OrchestrationId,
    runId: OrchestrationId,
    laneId: LaneId,
  }),
  z.object({
    type: z.literal("orchestration.rejected"),
    orchestrationId: OrchestrationId,
    runId: OrchestrationId,
    reason: text,
  }),
  z.object({
    type: z.literal("orchestration.merged"),
    orchestrationId: OrchestrationId,
    runId: OrchestrationId,
    laneId: LaneId,
    safetyCheckpoint: ref,
  }),
]);
export type OrchestrationEvent = z.infer<typeof OrchestrationEvent>;

/** Definition independent of run history; the host stores runs in pages. */
export const Orchestration = OrchestrationCreate.extend({
  id: OrchestrationId,
  currentRunId: OrchestrationId,
});
export type Orchestration = z.infer<typeof Orchestration>;
export const OrchestrationRunSummary = z.object({
  id: OrchestrationId,
  orchestrationId: OrchestrationId,
  status: OrchestrationRunStatus,
  startedAt: count,
  laneIds: z.array(LaneId).max(64),
  winner: LaneId.optional(),
  usage: OrchestrationUsage,
});
export type OrchestrationRunSummary = z.infer<typeof OrchestrationRunSummary>;
export const OrchestrationRunPage = z.object({
  runs: z.array(OrchestrationRunSummary).max(128),
  before: OrchestrationId.optional(),
});
