import { z } from "zod";
import { DeviceCredential, SocketTicket } from "@ace/protocol";
import { ClientError } from "./types.ts";

export type Credential = string | { token: string } | { ticket: string };
const HelloCredential = z.union([
  z.string().transform((token) => ({ token })),
  z.strictObject({ token: z.string() }),
  z.strictObject({ ticket: z.string() }),
]);
export function parseCredential(credential: Credential): { token: string } | { ticket: string } {
  return HelloCredential.parse(credential);
}
/** Exchange a device token for a new single-use ticket on every connection attempt.
 * The caller's exchange owns HTTP, response bounds and pinned TLS. */
export function ticketCredential(
  deviceToken: () => Promise<string>,
  exchange: (token: string) => Promise<unknown>,
): () => Promise<{ ticket: string }> {
  return async () => {
    try {
      const token = DeviceCredential.shape.token.parse(await deviceToken());
      const result = SocketTicket.parse(await exchange(token));
      return { ticket: result.ticket };
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw new ClientError("auth");
    }
  };
}
