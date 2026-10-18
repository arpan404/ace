import { KnownSpeed } from "@ace/protocol";
import { z } from "zod";
import { Picked } from "./thread-attachments.ts";
import { RequestAnswer } from "./thread-requests.ts";

/*
 * What the thread screen asks of the bridge. Swift sends the person's intent only; the bridge
 * builds every payload from the SDK reader.
 */

const requestId = z.string().min(1).max(64);
const ordinal = z.number().int().nonnegative();

export const ThreadAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    text: z.string().min(1),
    opposite: z.boolean(),
    requestId,
  }),
  z.object({ type: z.literal("stop"), requestId }),
  z.object({
    type: z.literal("answer"),
    interactionId: z.string().min(1),
    answers: z.record(z.string(), z.array(z.string().max(8192)).max(64)),
    dismissed: z.boolean(),
    requestId,
  }),
  /** A plan review, form or browser request answered on its card. */
  z.object({
    type: z.literal("resolve"),
    interactionId: z.string().min(1),
    answer: RequestAnswer,
    requestId,
  }),
  z.object({ type: z.literal("retrySend"), id: z.string().min(1), requestId }),
  z.object({ type: z.literal("loadOlder") }),
  z.object({ type: z.literal("models") }),
  z.object({ type: z.literal("switchModel"), model: z.string().min(1).max(256), requestId }),
  /** Effort for the next message; null goes back to the model's default. */
  z.object({ type: z.literal("effort"), effort: z.string().min(1).max(64).nullable(), requestId }),
  z.object({ type: z.literal("speed"), speed: KnownSpeed, requestId }),
  z.object({
    type: z.literal("queue"),
    messageId: z.string().min(1).max(256),
    change: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("remove") }),
      z.object({ kind: z.literal("steer") }),
      z.object({ kind: z.literal("words"), text: z.string().min(1) }),
      z.object({ kind: z.literal("move"), step: z.union([z.literal(-1), z.literal(1)]) }),
    ]),
    requestId,
  }),
  /** A settled "Worked for" log opened or closed, or asked for the rest of its steps. */
  z.object({ type: z.literal("steps.open"), ordinal, block: z.string().min(1).max(512) }),
  z.object({ type: z.literal("steps.close"), ordinal }),
  z.object({ type: z.literal("steps.more"), ordinal }),
  /** A native subagent's lane opened in its sheet, or closed. */
  z.object({ type: z.literal("lane.open"), agentId: z.string().min(1).max(256) }),
  z.object({ type: z.literal("lane.close") }),
  z.object({ type: z.literal("attach"), file: Picked }),
  z.object({ type: z.literal("detach"), localId: z.string().min(1).max(64) }),
]);
export type ThreadAction = z.infer<typeof ThreadAction>;
