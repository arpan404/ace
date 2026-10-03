import { z } from "zod";
import { ProviderPayloadSchema } from "@ace/provider-kit/payload";
import type { Frame } from "@ace/engine-api";
const admitted = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().finite().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.string().max(128),
  data: z.unknown(),
  payload: ProviderPayloadSchema,
});
export function accountFrame(input: unknown): Frame | undefined {
  const frame = admitted.safeParse(input).data;
  return frame && frame.data === frame.payload.data ? frame : undefined;
}
