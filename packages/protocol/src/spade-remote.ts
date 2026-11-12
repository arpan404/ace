import { z } from "zod";
import { HostId } from "./ids.ts";
import { maxSpadeRequestBytes } from "./spade.ts";

/**
 * Spade's bots on the person's other machines (ADR 0132, `spade/docs/teams.md` "What ace adds").
 * Spade asks its own daemon for the linked machines and sends inbox requests to one of them; the
 * daemons carry each request as a `spade` machine call. Bodies are Spade's: ace reads only `op`.
 */

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** One inbox request: a JSON object of at most `maxSpadeRequestBytes` (512 KiB) serialized. */
export const SpadeInboxRequest = z
  .record(z.string(), z.unknown())
  .refine((value) => jsonBytes(value) <= maxSpadeRequestBytes, {
    message: "The request is larger than 512 KiB.",
  })
  .meta({ "x-ace-constraint": "A JSON object of at most 512 KiB serialized." });
export type SpadeInboxRequest = z.infer<typeof SpadeInboxRequest>;

/** The target's answer to a `spade` machine call: Spade's status there and its JSON body. */
export const MachineSpadeResult = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
});
export type MachineSpadeResult = z.infer<typeof MachineSpadeResult>;

const requestId = z.string().min(1).max(128);

/** The linked machines this daemon can call, for Spade's `bots_list`. Operate scope. */
export const SpadeMachinesRequest = z.object({ type: z.literal("spade.machines"), requestId });
export const SpadeMachine = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  status: z.enum(["online", "offline"]),
});
export type SpadeMachine = z.infer<typeof SpadeMachine>;
export const SpadeMachinesResult = z.object({
  type: z.literal("spade.machines.result"),
  requestId: z.string(),
  machines: z.array(SpadeMachine).max(16),
});
export type SpadeMachinesResult = z.infer<typeof SpadeMachinesResult>;

/** One inbox request for Spade on the machine with that host id. Operate scope. Never retried. */
export const SpadeRemoteRequest = z.object({
  type: z.literal("spade.remote"),
  requestId,
  machine: HostId,
  request: SpadeInboxRequest,
});
export type SpadeRemoteRequest = z.infer<typeof SpadeRemoteRequest>;
export const SpadeRemoteErrorCode = z.enum([
  /** No linked machine has that host id. */
  "unknown_machine",
  /** The machine couldn't be reached; nothing was sent. */
  "offline",
  /** The connection was lost after the request was sent: it may have arrived. */
  "disconnected",
  /** That machine said no (its grants, Spade off there); `message` says why. */
  "refused",
  /** This device may not send requests to other machines. */
  "forbidden",
]);
export type SpadeRemoteErrorCode = z.infer<typeof SpadeRemoteErrorCode>;
export const SpadeRemoteOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("response"),
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  }),
  z.object({ kind: z.literal("error"), code: SpadeRemoteErrorCode, message: z.string().max(1024) }),
]);
export type SpadeRemoteOutcome = z.infer<typeof SpadeRemoteOutcome>;
export const SpadeRemoteResult = z.object({
  type: z.literal("spade.remote.result"),
  requestId: z.string(),
  result: SpadeRemoteOutcome,
});
export type SpadeRemoteResult = z.infer<typeof SpadeRemoteResult>;
