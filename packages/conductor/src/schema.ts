import { z } from "zod";
import {
  ConductorApproval,
  ConductorModel,
  ConductorPlan,
  ConductorPlanOnInsensitiveFilesystem,
  ConductorReview,
  ConductorSpec,
  ProviderKind,
} from "@ace/protocol";

/** Execution intents require a native root identity; the wire stays additive. */
export const StartSpec = ConductorSpec.refine(
  (spec) => z.uuid().safeParse(spec.rootAgentId).success,
  { path: ["rootAgentId"], message: "Native conductor root must be a UUID" },
);
export const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const Text = z.string().min(1).max(16_384);
export const Completion = z.object({
  branch: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,255}$/)
    .refine((b) => !b.endsWith("/") && !b.includes("//")),
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  summary: Text,
  pr: z.string().url().max(2048).optional(),
});
export type Completion = z.infer<typeof Completion>;
export const Account = z.object({
  id: Key,
  provider: ProviderKind,
  capacity: z.number().int().min(0).max(64),
  externalActive: z.number().int().min(0).max(64),
  quota: z.number().finite().nonnegative(),
  resetAt: z.number().int().nonnegative().nullable(),
});
export type Account = z.infer<typeof Account>;
export const Role = z.enum(["planner", "worker", "reviewer", "integrator"]);
export type Role = z.infer<typeof Role>;
export const Artifact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: ConductorPlan }),
  z.object({ kind: z.literal("completion"), completion: Completion }),
  z.object({
    kind: z.literal("review"),
    review: ConductorReview,
    revision: Completion.shape.revision,
  }),
]);
export type Artifact = z.infer<typeof Artifact>;
const ObservedStatus = z.enum(["working", "waiting", "done", "failed", "unresponsive"]);
export const Lane = z.object({
  id: Key,
  agentId: z.string().uuid(),
  workstream: Key.nullable(),
  role: Role,
  generation: z.number().int().nonnegative(),
  account: Key,
  model: ConductorModel,
  status: z.enum([
    "starting",
    "working",
    "waiting",
    "done",
    "failed",
    "unresponsive",
    "limited",
    "migrating",
  ]),
  lastActivity: z.number().int().nonnegative(),
  artifactDeadline: z.number().int().nonnegative().nullable().default(null),
  migrationObservation: z
    .object({ status: ObservedStatus.or(z.literal("limited")), at: z.number().int().nonnegative() })
    .nullable()
    .default(null),
  artifact: Artifact.nullable(),
  correctionPending: z.boolean().default(false),
  artifactRetries: z.number().int().min(0).max(2).default(0),
  rejectedArtifact: z.string().max(256).nullable().default(null),
  source: Key.nullable(),
  live: z.boolean(),
  retiring: z.boolean(),
  stopRequestedAt: z.number().int().nonnegative().nullable().default(null),
});
export type Lane = z.infer<typeof Lane>;
export const Node = z.object({
  id: Key,
  state: z.enum([
    "pending",
    "working",
    "review_pending",
    "reviewing",
    "fix_pending",
    "approved",
    "merging",
    "verifying",
    "conflict_pending",
    "escalated",
    "integrated",
    /** The person rejected its merge or escalation: it never merges and its dependants never start. */
    "declined",
  ]),
  lane: Key.nullable(),
  worker: Key.nullable(),
  fixRounds: z.number().int().nonnegative(),
  completion: Completion.nullable(),
  reviews: z
    .array(z.object({ verdict: ConductorReview.shape.verdict, summary: z.string().max(2048) }))
    .max(24),
  lastReview: ConductorReview.nullable(),
  mergedRevision: Completion.shape.revision.nullable(),
  conflict: Text.nullable(),
  trivialConflict: z.boolean(),
  mergeApproved: z.boolean(),
  operation: Key.nullable(),
  integrationKey: Key.nullable().default(null),
});
export type Node = z.infer<typeof Node>;
export const Gate = z.object({
  id: Key,
  kind: z.enum(["plan", "merge", "budget", "escalation", "deadline", "destructive"]),
  workstream: Key.nullable(),
  lane: Key.nullable(),
  generation: z.number().int().nonnegative().nullable(),
  message: Text,
  gatedAt: z.number().int().nonnegative().default(0),
});
export type Gate = z.infer<typeof Gate>;
export const State = z
  .object({
    version: z.literal(1),
    startedAt: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int().nonnegative().default(0),
    id: Key,
    spec: ConductorSpec,
    phase: z.enum(["planning", "running", "paused", "cancelling", "cancelled", "done"]),
    beforePause: z.enum(["planning", "running"]),
    plan: ConductorPlan.nullable(),
    planApproved: z.boolean(),
    /** The summary of the last plan the person rejected; the planner's next draft must differ. */
    rejectedPlan: z.string().max(16_384).nullable().default(null),
    ownershipCase: z.enum(["sensitive", "insensitive"]).default("insensitive"),
    accounts: z.array(Account).max(64),
    lanes: z.record(Key, Lane),
    nodes: z.record(Key, Node),
    gates: z.record(Key, Gate),
    spent: z.number().finite().nonnegative(),
    integration: Key.nullable(),
    planner: Key.nullable(),
  })
  .superRefine((s, ctx) => {
    if (
      Object.keys(s.lanes).length > 8192 ||
      Object.keys(s.nodes).length > 256 ||
      Object.keys(s.gates).length > 512
    )
      ctx.addIssue({ code: "custom", message: "run indexes exceed capacity" });
    if (s.ownershipCase === "insensitive" && s.plan) {
      const admitted = ConductorPlanOnInsensitiveFilesystem.safeParse(s.plan);
      if (!admitted.success)
        for (const issue of admitted.error.issues)
          ctx.addIssue({ code: "custom", message: issue.message });
    }
  });
export type State = z.infer<typeof State>;
const LaneRef = { laneId: Key, generation: z.number().int().nonnegative() };
export const Fact = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accounts"), accounts: z.array(Account).max(64) }),
  z.object({
    type: z.literal("status"),
    ...LaneRef,
    status: ObservedStatus,
    at: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("artifact"), ...LaneRef, artifact: Artifact }),
  z.object({
    type: z.literal("artifact_invalid"),
    ...LaneRef,
    itemId: z.string().min(1).max(256),
    error: Text,
  }),
  z.object({ type: z.literal("artifact_correction_started"), ...LaneRef }),
  z.object({ type: z.literal("usage_limit"), ...LaneRef }),
  z.object({ type: z.literal("migrated"), ...LaneRef }),
  z.object({
    type: z.literal("merge_result"),
    workstream: Key,
    operationId: Key,
    revision: Completion.shape.revision,
    conflict: Text.nullable(),
    trivial: z.boolean(),
  }),
  z.object({
    type: z.literal("verified"),
    workstream: Key,
    operationId: Key,
    revision: Completion.shape.revision,
    passed: z.boolean(),
    summary: Text,
  }),
  z.object({ type: z.literal("approve"), approval: ConductorApproval }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("tick") }),
  z.object({ type: z.literal("destructive"), ...LaneRef, description: Text }),
]);
export type Fact = z.infer<typeof Fact>;
export const Effect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("correct_artifact"), id: Key, lane: Lane, error: Text }),
  z.object({
    type: z.literal("launch"),
    id: Key,
    lane: Lane,
    prompt: z.string().max(2_000_000),
    rootAgentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    completion: Completion.nullable(),
    conflict: Text.nullable().default(null),
    dependencies: z.array(Completion).max(256),
  }),
  z.object({ type: z.literal("migrate"), id: Key, lane: Lane, fromAccount: Key }),
  z.object({
    type: z.literal("control"),
    id: Key,
    lane: Lane,
    action: z.enum(["pause", "resume", "cancel", "force_cancel", "allow_destructive"]),
  }),
  z.object({ type: z.literal("gate"), id: Key, gate: Gate, rootAgentId: z.string().uuid() }),
  z.object({ type: z.literal("gate_closed"), id: Key, gateId: Key }),
  z.object({
    type: z.literal("merge"),
    id: Key,
    workstream: Key,
    completion: Completion,
    mode: z.enum(["local", "pr"]),
  }),
  z.object({
    type: z.literal("verify"),
    id: Key,
    workstream: Key,
    revision: Completion.shape.revision,
    mode: z.enum(["local", "pr"]),
  }),
]);
export type Effect = z.infer<typeof Effect>;
export interface Environment {
  now(): number;
  id(): string;
  agentId(): string;
  /** Pure lookup of workspace semantics probed by the I/O boundary. Unknown defaults to insensitive. */
  ownershipCase?(workspaceId: string): "sensitive" | "insensitive";
}
export interface Transition {
  state: State;
  effects: Effect[];
}
