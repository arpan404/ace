import { z } from "zod";
import { DeviceToken, SocketTicket } from "@ace/protocol";
import { ClientError } from "./errors.ts";

/**
 * What a hello presents: a device token, a one-use ticket, or a device grant from the ace
 * account backend (ADR 0111) with the machine code when the daemon asked for one.
 */
export type Credential =
  | string
  | { token: string }
  | { ticket: string }
  | { grant: string; machineCode?: string };
const HelloCredential = z.union([
  z.string().transform((token) => ({ token })),
  z.strictObject({ token: z.string() }),
  z.strictObject({ ticket: z.string() }),
  z.strictObject({ grant: z.string(), machineCode: z.string().optional() }),
]);
export function parseCredential(
  credential: Credential,
): { token: string } | { ticket: string } | { grant: string; machineCode?: string | undefined } {
  return HelloCredential.parse(credential);
}
/** The grant to offer the relay itself, when the credential is an account grant. */
export function relayGrant(credential: Credential): string | undefined {
  return typeof credential === "object" && "grant" in credential ? credential.grant : undefined;
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
