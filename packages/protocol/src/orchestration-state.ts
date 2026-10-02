import { z } from "zod";
import {
  OrchestrationCreate,
  OrchestrationId,
  OrchestrationLane,
  OrchestrationRunStatus,
  OrchestrationUsage,
} from "./orchestration.ts";
import { OrchestrationIntent } from "./orchestration-execution.ts";
const count = z.number().int().nonnegative().max(64);
export const OrchestrationState = z.object({
  id: OrchestrationId,
  runId: OrchestrationId,
  input: OrchestrationCreate,
  startedAt: z.number().int().nonnegative(),
  status: OrchestrationRunStatus,
  stopReason: z.enum(["cancelled", "budget_exhausted", "winner"]).optional(),
  lanes: z.record(OrchestrationId, OrchestrationLane).refine((v) => Object.keys(v).length <= 64),
  intents: z
    .record(OrchestrationId, OrchestrationIntent)
    .refine((v) => Object.keys(v).length <= 129),
  spawnReceipts: z
    .record(z.string().max(300), OrchestrationId)
    .refine((v) => Object.keys(v).length <= 64),
  open: count,
  waiting: count,
  succeeded: count,
  failed: count,
  usage: OrchestrationUsage,
  winner: OrchestrationId.optional(),
  mergeRequested: z.boolean(),
  mergeStatus: z.enum(["none", "pending", "applied", "failed"]),
  safetyCheckpoint: z.string().max(512).optional(),
});
export type OrchestrationState = z.infer<typeof OrchestrationState>;
