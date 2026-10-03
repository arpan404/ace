import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { PreviewDescriptor, PreviewPort } from "./preview.ts";
const id = z.string().min(1).max(128);
export const PreviewRequest = z.object({
  type: z.literal("preview.request"),
  requestId: id,
  threadId: ThreadId,
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("list") }),
    z.object({ op: z.literal("forward"), port: PreviewPort }),
    z.object({ op: z.literal("unforward"), port: PreviewPort }),
  ]),
});
export const PreviewResult = z.object({
  type: z.literal("preview.result"),
  requestId: id,
  ok: z.boolean(),
  error: z.string().max(128).optional(),
  previews: z.array(PreviewDescriptor).max(64).optional(),
});

export type PreviewRequest = z.infer<typeof PreviewRequest>;
export type PreviewResult = z.infer<typeof PreviewResult>;
