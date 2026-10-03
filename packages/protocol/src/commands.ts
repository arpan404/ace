import { z } from "zod";
import { DiagnosticsHealthCommand } from "./diagnostics.ts";
import { MessageContext } from "./context.ts";
import { ConductorCommandPayload } from "./conductor.ts";
import {
  AgentId,
  BackgroundTaskId,
  CommandId,
  DeviceId,
  InteractionId,
  ThreadId,
  WorkspaceId,
} from "./ids.ts";
import { InteractionResolution } from "./interactions.ts";
import { ContentPart } from "./items.ts";
import { ProviderKind } from "./provider.ts";

import { ReviewCommands } from "./review.ts";
import {
  OrchestrationCreateCommand,
  OrchestrationCancelCommand,
  OrchestrationPickCommand,
} from "./orchestration-execution.ts";

export const CommandPayload = z.discriminatedUnion("type", [
  DiagnosticsHealthCommand,
  ...ConductorCommandPayload.options,
  ...ReviewCommands,
  OrchestrationCreateCommand,
  OrchestrationCancelCommand,
  OrchestrationPickCommand,
  z.object({
    type: z.literal("thread.create"),
    /** Explicit portable fork/migration, preserving the source and allocating fresh native state. */
    handoffFrom: ThreadId.optional(),
    workspaceId: WorkspaceId,
    provider: ProviderKind,
    model: z.string().optional(),
    title: z.string().optional(),
    input: z.array(ContentPart).min(1),
    context: MessageContext.optional(),
  }),
  z.object({
    type: z.literal("thread.send"),
    threadId: ThreadId,
    input: z.array(ContentPart).min(1),
    context: MessageContext.optional(),
    /**
     * `steer` injects into the running turn when the provider supports it;
     * `queue` waits for the thread to settle. Unsupported steer falls back to queue.
     */
    delivery: z.enum(["steer", "queue"]),
  }),
  z.object({
    type: z.literal("thread.interrupt"),
    threadId: ThreadId,
    /** Defaults to the root agent. */
    agentId: AgentId.optional(),
    /** Also stop every descendant, even when the provider doesn't cascade. */
    cascade: z.boolean().default(true),
  }),
  z.object({ type: z.literal("thread.archive"), threadId: ThreadId }),
  z.object({
    type: z.literal("interaction.resolve"),
    interactionId: InteractionId,
    resolution: InteractionResolution,
  }),
  z.object({ type: z.literal("background_task.stop"), taskId: BackgroundTaskId }),
]);
export type CommandPayload = z.infer<typeof CommandPayload>;

/** Client → daemon. `id` makes retries idempotent: the daemon applies each id once. */
export const Command = z.object({
  id: CommandId,
  deviceId: DeviceId,
  payload: CommandPayload,
});
export type Command = z.infer<typeof Command>;
