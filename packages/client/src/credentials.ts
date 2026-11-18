import { z } from "zod";
import { DeviceToken, PairingLinkProof, SocketTicket } from "@ace/protocol";
import { ClientError } from "./errors.ts";

/**
 * What a hello presents: a device token, a one-use ticket, or a device grant from the ace
 * account backend (ADR 0111) with its standing grant (ADR 0190), the machine code when the
 * daemon asked for one, and the proof of this install's paired credential on that machine
 * (`link`, ADR 0115) when it has one. The standing grant goes in the hello only, never to the
 * relay.
 */
export type Credential =
  | string
  | { token: string }
  | { ticket: string }
  | { grant: string; standing?: string; machineCode?: string; link?: PairingLinkProof };
const HelloCredential = z.union([
  z.string().transform((token) => ({ token })),
  z.strictObject({ token: z.string() }),
  z.strictObject({ ticket: z.string() }),
  z.strictObject({
    grant: z.string(),
    standing: z.string().optional(),
    machineCode: z.string().optional(),
    link: PairingLinkProof.optional(),
  }),
]);
export function parseCredential(credential: Credential):
  | { token: string }
  | { ticket: string }
  | {
      grant: string;
      standing?: string | undefined;
      machineCode?: string | undefined;
      link?: PairingLinkProof | undefined;
    } {
  return HelloCredential.parse(credential);
}
/** The grant to offer the relay itself, when the credential is an account grant. */
export function relayGrant(credential: Credential): string | undefined {
  return typeof credential === "object" && "grant" in credential ? credential.grant : undefined;
}
/** The standing grant beside an account grant (ADR 0190): for the hello, never the relay. */
export function helloStanding(credential: Credential): string | undefined {
  return typeof credential === "object" && "grant" in credential ? credential.standing : undefined;
}
/** Exchange a device token for a new single-use ticket on every connection attempt.
 * The caller's exchange owns HTTP, response bounds and pinned TLS. */
export function ticketCredential(
  deviceToken: () => Promise<string>,
  exchange: (token: string) => Promise<unknown>,
): () => Promise<{ ticket: string }> {
  return async () => {
    try {
      const token = DeviceToken.parse(await deviceToken());
      const result = SocketTicket.parse(await exchange(token));
      return { ticket: result.ticket };
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError("auth");
    }
  };
}
