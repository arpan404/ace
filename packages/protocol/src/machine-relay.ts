import { z } from "zod";
import { MachineCallRequest } from "./machine-calls.ts";
import { MachineTransferCall, TransferKey, maxTransferBytes } from "./machine-transfers.ts";

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
  /** How long the caller waits for it: past this the machine stops it rather than run it late. */
  timeoutMs: z.int().min(1).max(3_600_000).optional(),
});
export type MachineRelayCall = z.infer<typeof MachineRelayCall>;

/**
 * The caller stopped waiting (it timed out or was cancelled): the machine stops the call, as a
 * closed request stops it on the TLS listener, or drops it if it hadn't started.
 */
export const MachineRelayCancel = z.strictObject({
  type: z.literal("machine.cancel"),
  id: CallId,
});
export type MachineRelayCancel = z.infer<typeof MachineRelayCancel>;

/** The answer as `/v1/machine-calls` gives it: its HTTP status and JSON body. */
export const MachineRelayAnswer = z.strictObject({
  type: z.literal("machine.answer"),
  id: CallId,
  status: z.int().min(100).max(599),
  body: z.unknown(),
});
export type MachineRelayAnswer = z.infer<typeof MachineRelayAnswer>;

/**
 * Bytes of a transfer chunk per relay piece (ADR 0192). A chunk sent through a relay is split
 * into pieces of at most this, each acknowledged by offset like a chunk on the TLS listener.
 * Base64 of it is about 1.4 MB of JSON: well under the relay's 16 MiB message, quick to deflate,
 * and small enough that a slow link acknowledges each piece well inside its timeout.
 */
export const transferRelayPieceBytes = 1024 * 1024;

/**
 * One transfer call through a relay (ADR 0101, ADR 0192): what `POST /v1/transfers` and
 * `PUT /v1/transfers/chunk` take on the TLS listener, in one frame. The chunk's bytes are base64.
 * Never a machine call: transfers keep their own authority (`operate` and `projects`).
 */
export const TransferRelayRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("call"), call: MachineTransferCall }),
  z.strictObject({
    kind: z.literal("chunk"),
    transferId: TransferKey,
    offset: z.int().min(0).max(maxTransferBytes),
    part: z.enum(["code", "ignored"]),
    data: z
      .string()
      .min(1)
      .max(Math.ceil(transferRelayPieceBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
]);
export type TransferRelayRequest = z.infer<typeof TransferRelayRequest>;

/** A transfer call on a relay `machine` stream, answered by `machine.answer` with its id. */
export const MachineRelayTransfer = z.strictObject({
  type: z.literal("machine.transfer"),
  id: CallId,
  request: TransferRelayRequest,
  timeoutMs: z.int().min(1).max(3_600_000).optional(),
});
export type MachineRelayTransfer = z.infer<typeof MachineRelayTransfer>;
