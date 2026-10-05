import { z } from "zod";
import { ConductorPlan, ConductorSpec } from "./conductor.ts";
const timestamp = z.number().int().nonnegative();
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const ConductorSummary = z.object({
  id,
  workspaceId: ConductorSpec.shape.workspaceId,
  goal: z.string().max(16_384),
  phase: z.enum(["planning", "running", "paused", "cancelling", "cancelled", "done"]),
  spent: z.number().finite().nonnegative(),
  budget: z.number().finite().nonnegative(),
});
export const ConductorRunView = ConductorSummary.extend({
  startedAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
  delegations: z
    .array(
      z.object({
        laneId: id,
        workstream: id.nullable(),
        threadId: z.string(),
        agentId: z.string().nullable(),
        parentThreadId: z.string(),
        parentAgentId: z.string(),
        provider: z.string().max(128),
        account: z.string().max(128).nullable(),
        generation: z.number().int().nonnegative(),
        phase: z.enum(["created", "running", "cancelling", "settled"]),
      }),
    )
    .max(256)
    .default([]),
  plan: ConductorPlan.nullable(),
  planApproved: z.boolean(),
  needsUser: z
    .array(
      z.object({
        id,
        kind: z.enum([
          "plan",
          "merge",
          "budget",
          "escalation",
          "deadline",
          "destructive",
          "provider",
        ]),
        workstream: id.nullable(),
        lane: id.nullable(),
        generation: z.number().int().nonnegative().nullable(),
        message: z.string().max(2048),
        gatedAt: timestamp.default(0),
        interactionId: z.string().optional(),
        threadId: z.string().optional(),
      }),
    )
    .max(64),
  lanes: z
    .array(
      z.object({
        id,
        agentId: z.string(),
        role: z.enum(["planner", "worker", "reviewer", "integrator"]),
        workstream: id.nullable(),
        account: id,
        model: z.string().max(256),
        generation: z.number().int().nonnegative(),
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
      }),
    )
    .max(64),
  dag: z
    .array(
      z.object({
        id,
        title: z.string().max(256),
        dependencies: z.array(id).max(256),
        state: z.string().max(64).optional(),
        fixRounds: z.number().int().nonnegative().optional(),
        revision: z.string().nullable().optional(),
        /** The latest review verdicts, oldest first; summaries are cut to 512 characters. */
        reviews: z
          .array(
            z.object({
              verdict: z.enum(["pass", "changes_required"]),
              summary: z.string().max(512),
            }),
          )
          .max(4)
          .optional(),
      }),
    )
    .max(256),
  /** The Deck branch cards merge into, and the branch it started from, once the run has one. */
  branch: z.string().max(256).nullable().optional(),
  baseBranch: z.string().max(256).nullable().optional(),
  truncated: z.boolean(),
  executionError: z.string().max(128).optional(),
});
export type ConductorRunView = z.infer<typeof ConductorRunView>;
export const ConductorRequest = z.object({
  type: z.literal("conductor.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("list"),
      after: id.optional(),
      limit: z.number().int().min(1).max(32).default(16),
    }),
    z.object({ op: z.literal("get"), runId: id }),
    z.object({ op: z.literal("subscribe"), runId: id, subscriptionId: id }),
    z.object({ op: z.literal("unsubscribe"), subscriptionId: id }),
  ]),
});
export const ConductorResult = z.object({
  type: z.literal("conductor.result"),
  requestId: id,
  ok: z.boolean(),
  error: z.string().max(128).optional(),
  runs: z.array(ConductorSummary).max(32).optional(),
  run: ConductorRunView.optional(),
  next: id.optional(),
});
export const ConductorChanged = z.object({
  type: z.literal("conductor.changed"),
  subscriptionId: id,
  run: ConductorRunView,
});

export type ConductorSummary = z.infer<typeof ConductorSummary>;
export type ConductorRequest = z.infer<typeof ConductorRequest>;
export type ConductorResult = z.infer<typeof ConductorResult>;
export type ConductorChanged = z.infer<typeof ConductorChanged>;
