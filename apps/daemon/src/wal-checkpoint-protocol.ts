import { z } from "zod";

export const CheckpointWorkerData = z.object({ path: z.string().min(1) });
export const CheckpointMode = z.enum(["PASSIVE", "TRUNCATE"]);
export type CheckpointMode = z.infer<typeof CheckpointMode>;
export const CheckpointRequest = z.object({ id: z.number().int(), mode: CheckpointMode });
/** `busy`: another connection held a lock the checkpoint needed; it retries later. */
export const CheckpointReply = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int(), ok: z.literal(true), busy: z.boolean() }),
  z.object({ id: z.number().int(), ok: z.literal(false), busy: z.boolean(), error: z.string() }),
]);
export type CheckpointReply = z.infer<typeof CheckpointReply>;
