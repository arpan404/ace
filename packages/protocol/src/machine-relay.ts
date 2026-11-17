import { z } from "zod";
import { MachineCallRequest } from "./machine-calls.ts";

/**
 * Machine calls through a relay (ADR 0182): a paired machine that can't reach another directly
 * opens an end-to-end encrypted relay stream to it, says `hello` with `channel: "machine"` and
 * its paired-device token, and sends the same calls it would POST to `/v1/machine-calls`. The
 * relay sees only ciphertext. Each call carries an id its answer repeats.
 */
const CallId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

export const MachineRelayCall = z.strictObject({
  type: z.literal("machine.call"),
  id: CallId,
  request: MachineCallRequest,
});
export type MachineRelayCall = z.infer<typeof MachineRelayCall>;

/** The answer as `/v1/machine-calls` gives it: its HTTP status and JSON body. */
export const MachineRelayAnswer = z.strictObject({
  type: z.literal("machine.answer"),
  id: CallId,
  status: z.int().min(100).max(599),
  body: z.unknown(),
});
export type MachineRelayAnswer = z.infer<typeof MachineRelayAnswer>;
