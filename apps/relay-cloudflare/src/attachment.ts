import { z } from "zod";
import { HostId, Ticket } from "@ace/relay/wire";
import type { PendingTicket } from "@ace/relay/wire";

const Cipher = z.object({
  key: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
  nonce: z.bigint().nonnegative(),
});
export type CipherSnapshot = z.infer<typeof Cipher>;

/**
 * What each socket remembers through hibernation. The object's memory is lost when it sleeps;
 * these attachments, kept by the runtime with their sockets, are the relay's whole state.
 */
export const Attachment = z.discriminatedUnion("kind", [
  /**
   * A daemon's control socket before its Noise handshake ends. Its `hostId` is only claimed;
   * `account` comes from its machine grant.
   */
  z.object({ kind: z.literal("handshake"), id: z.string(), hostId: HostId, account: z.string() }),
  /** A daemon whose handshake proved `hostId`, with its account and registration session. */
  z.object({
    kind: z.literal("host"),
    id: z.string(),
    hostId: HostId,
    account: z.string(),
    send: Cipher,
    receive: Cipher,
    /** It registered with `features=http` and takes forwarded HTTP tickets (ADR 0122). */
    http: z.literal(true).optional(),
  }),
  /** A client waiting for its host to join `ticket`. `owner` is the host socket offered it. */
  z.object({
    kind: z.literal("waiting"),
    id: z.string(),
    ticket: Ticket,
    owner: z.string(),
    expires: z.number(),
  }),
  /** One side of a paired stream; frames go to `peer`. */
  z.object({ kind: z.literal("stream"), id: z.string(), peer: z.string() }),
]);
export type Attachment = z.infer<typeof Attachment>;

/** Routing facts recorded in attachments, for `RelayRoutes.restore`. */
export function routeFacts(attachments: readonly Attachment[]): {
  hosts: { socket: string; hostId: string }[];
  pending: PendingTicket[];
} {
  const hosts: { socket: string; hostId: string }[] = [];
  const pending: PendingTicket[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "host")
      hosts.push({ socket: attachment.id, hostId: attachment.hostId });
    if (attachment.kind === "waiting")
      pending.push({
        ticket: attachment.ticket,
        client: attachment.id,
        owner: attachment.owner,
        expires: attachment.expires,
      });
  }
  return { hosts, pending };
}

/** The account of the daemon registered as `hostId` here, if one is. */
export function hostAccount(
  attachments: readonly Attachment[],
  hostId: string,
): string | undefined {
  for (const attachment of attachments)
    if (attachment.kind === "host" && attachment.hostId === hostId) return attachment.account;
  return undefined;
}

/** When the next waiting client expires, if any is waiting. */
export function nextExpiry(attachments: readonly Attachment[]): number | undefined {
  let next: number | undefined;
  for (const attachment of attachments)
    if (attachment.kind === "waiting" && (next === undefined || attachment.expires < next))
      next = attachment.expires;
  return next;
}
