import { z } from "zod";
import { CommandId, ThreadId } from "./ids.ts";
import { ContentPart } from "./items.ts";
import { MessageContext } from "./context.ts";
import { AccountId } from "./account-ids.ts";
import { SwitchSelection } from "./thread-transitions.ts";

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
  /** Explicit model/options changes must wait for the next settled turn. */
  requiresNextTurn: z.boolean().optional(),
  state: z.enum(["queued", "uncertain"]),
  /** A steer that couldn't go into the running turn: it waits here as the next message. */
  fellBack: z.literal(true).optional(),
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
  /**
   * With `reason: "restart"`: the provider's process died on its own while ace kept running,
   * rather than ace restarting. The turn holds and resumes exactly as after a restart; only
   * what it is called differs ("Cursor stopped unexpectedly", not "Stopped by a restart").
   */
  exited: z.boolean().optional(),
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
    /**
     * `switch`: move the held work to `selection` (another account, model or provider, with a
     * context handoff across providers) and carry it on there. `cancel_resume`: drop a chosen
     * resume at reset; the thread stays held by its limit.
     */
    action: z.enum([
      "resume_now",
      "resume_at_reset",
      "snooze_until_reset",
      "migrate_now",
      "switch",
      "cancel_resume",
    ]),
    instanceId: AccountId.optional(),
    /** With `switch`: where the held work carries on. */
    selection: SwitchSelection.optional(),
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
