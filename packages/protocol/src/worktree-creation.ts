import { z } from "zod";
import { CommandId, ThreadId } from "./ids.ts";

/** Creation precedes thread admission. commandId also identifies its retained first message. */
export const WorktreeCreationProgress = z.object({
  commandId: CommandId,
  threadId: ThreadId.optional(),
  attempt: z.number().int().nonnegative(),
  state: z.enum(["running", "cancelling", "cancelled", "failed", "done", "local"]),
  step: z.enum(["preparing", "fetching", "creating", "checking_out", "setup", "done"]),
  percent: z.number().int().min(0).max(100).optional(),
  startedAt: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  steps: z
    .array(
      z.object({
        step: z.enum(["preparing", "fetching", "creating", "checking_out", "setup", "done"]),
        startedAt: z.number().int().nonnegative(),
        elapsedMs: z.number().int().nonnegative(),
      }),
    )
    .max(6),
  /** Redacted whole lines only; oldest lines are evicted. Oversized lines are omitted. */
  details: z.array(z.string().max(1024)).max(200),
  message: z.string().max(256).optional(),
  /** False when uncertain writers or changed resources prevent safe cleanup. */
  cleanupComplete: z.boolean(),
  actions: z.array(z.enum(["cancel", "local", "retry"])).max(3),
});
export type WorktreeCreationProgress = z.infer<typeof WorktreeCreationProgress>;
export const WorktreeCreationRequest = z.object({
  type: z.literal("worktree.creation.request"),
  requestId: z.string().min(1).max(256),
  commandId: CommandId,
  /** `get` restores progress after reconnect; other actions require operate scope. */
  action: z.enum(["get", "cancel", "local", "retry"]),
});
export const WorktreeCreationEvent = WorktreeCreationProgress.extend({
  type: z.literal("worktree.creation.progress"),
});
export const WorktreeCreationResult = z.object({
  type: z.literal("worktree.creation.result"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.enum(["not_found", "forbidden", "busy", "cleanup_required", "settled"]).optional(),
  progress: WorktreeCreationProgress.optional(),
});
