import { z } from "zod";
import { CommandId, ThreadId } from "./ids.ts";
import { ContentPart } from "./items.ts";
import { MessageContext } from "./context.ts";
import { AccountId } from "./account-ids.ts";

export const FollowUpBehavior = z.enum(["steer", "queue"]);
export type FollowUpBehavior = z.infer<typeof FollowUpBehavior>;
export const LimitPolicy = z.enum([
  "manual",
  "resume_at_reset",
  "snooze_until_reset",
  "migrate_now",
]);
export const QueueInput = z.array(ContentPart).min(1).max(64);
export const QueuedMessage = z.object({
  id: CommandId,
  input: z.array(ContentPart).min(1),
  context: MessageContext.optional(),
  delivery: FollowUpBehavior,
  state: z.enum(["queued", "uncertain"]),
});
export type QueuedMessage = z.infer<typeof QueuedMessage>;
export const QueueState = z.object({
  pendingCount: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  lastFailure: z
    .object({ title: z.string().min(1).max(256), code: z.string().min(1).max(128) })
    .nullable()
    .optional(),
  reason: z
    .enum([
      "manual",
      "restart",
      "limit",
      "snooze",
      "uncertain",
      "stopped",
      "not_sent",
      "model_unavailable",
    ])
    .nullable(),
  resumeAt: z.number().int().nonnegative().nullable(),
});
export const QueueSnapshot = QueueState.extend({
  threadId: ThreadId,
  messages: z.array(QueuedMessage).max(256),
});
export type QueueSnapshot = z.infer<typeof QueueSnapshot>;
const target = {
  threadId: ThreadId,
  expectedRevision: z.number().int().nonnegative(),
};
export const QueueCommands = [
  z.object({
    type: z.literal("queue.edit"),
    ...target,
    messageId: CommandId,
    input: QueueInput,
    context: MessageContext.optional(),
    delivery: FollowUpBehavior.optional(),
  }),
  z.object({
    type: z.literal("queue.move"),
    ...target,
    messageId: CommandId,
    after: CommandId.nullable(),
  }),
  z.object({ type: z.literal("queue.remove"), ...target, messageId: CommandId }),
  z.object({ type: z.literal("queue.pause"), ...target }),
  z.object({ type: z.literal("queue.resume"), ...target }),
  z.object({ type: z.literal("thread.resume"), ...target }),
  z.object({
    type: z.literal("thread.limit"),
    ...target,
    action: z.enum(["resume_now", "resume_at_reset", "snooze_until_reset", "migrate_now"]),
    instanceId: AccountId.optional(),
  }),
] as const;
export const QueueGet = z.object({
  type: z.literal("queue.get"),
  requestId: z.string().min(1).max(128),
  threadId: ThreadId,
  after: CommandId.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(32).optional(),
});
export type QueueGet = z.infer<typeof QueueGet>;
export const QueuePage = QueueSnapshot.extend({
  messages: z.array(QueuedMessage).max(32),
  total: z.number().int().nonnegative(),
  next: CommandId.nullable(),
});
export type QueuePage = z.infer<typeof QueuePage>;
export const QueueResult = z.object({
  type: z.literal("queue.result"),
  requestId: z.string(),
  queue: QueuePage,
});
export const QueueUpdated = QueueState.extend({ type: z.literal("queue.updated") });
