import { z } from "zod";
import { DeviceCredential, PairingRedemption } from "./remote.ts";

/**
 * The daemon is closing a relayed main channel, sent as its last message. A relay channel has
 * no WebSocket close frame of its own, so this carries the code and reason a direct socket's
 * close would (4003 revoked, 4008 idle, 4009 backpressure, 4012 account access changed, 4013
 * capacity, 4014 account grant expired, the resync code).
 */
export const ChannelClose = z.object({
  type: z.literal("channel.close"),
  code: z.number().int().min(1000).max(4999),
  reason: z.string().max(123),
});
export type ChannelClose = z.infer<typeof ChannelClose>;

/**
 * The close a paired device gets when the machine's owner revokes it: code 4003 with exactly
 * this reason, on a direct socket or as a relay `channel.close`. Only this close lets a client
 * delete what it read from the machine; signing out, another account, an expired or refused
 * grant and a new machine code never do.
 */
export const DeviceRevokedClose = z.object({
  code: z.literal(4003),
  reason: z.literal("Device revoked"),
});
export type DeviceRevokedClose = z.infer<typeof DeviceRevokedClose>;

/**
 * The close a paired device's sockets get when the same install pairs the machine again and its
 * old credential is replaced (ADR 0115): code 4001 with exactly this reason. Unlike any other
 * 4001 it is not a final refusal: the client connects again with the credential it holds now,
 * and if that is still the replaced one the daemon refuses it with a plain 4001.
 */
export const CredentialReplacedClose = z.object({
  code: z.literal(4001),
  reason: z.literal("Credential replaced"),
});
export type CredentialReplacedClose = z.infer<typeof CredentialReplacedClose>;

/**
 * Redeem a pairing code through a relay (ADR 0070), as the first and only message of a relay
 * channel, in place of a hello. The daemon answers with `pair.result` and closes the channel.
 * Only self-hosted relays carry it: ace's hosted relay admits signed-in account devices only.
 */
export const PairRedeem = PairingRedemption.extend({ type: z.literal("pair.redeem") });
export type PairRedeem = z.infer<typeof PairRedeem>;

/** Why a relayed pairing redemption was refused. */
export const PairRefusal = z.enum([
  /** Wrong, used or expired code. */
  "invalid",
  /** Too many attempts; try again in a minute. */
  "rate_limited",
  /** The daemon couldn't pair right now. */
  "unavailable",
]);
export type PairRefusal = z.infer<typeof PairRefusal>;

export const PairResult = z.object({
  type: z.literal("pair.result"),
  result: z.discriminatedUnion("ok", [
    DeviceCredential.extend({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: PairRefusal, message: z.string().max(256) }),
  ]),
});
export type PairResult = z.infer<typeof PairResult>;
