import { SocketTicket } from "@ace/protocol";
import type { z } from "zod";
import { ticketCredential } from "./credentials.ts";
import { accessHttp, type AccessOptions } from "./access-http.ts";

/** Exchange one paired credential without loading device-management operations. */
export async function accessTicket(
  options: AccessOptions,
  signal?: AbortSignal,
): Promise<z.infer<typeof SocketTicket>> {
  return SocketTicket.parse(
    await accessHttp(options)("/v1/tickets", "POST", undefined, true, signal),
  );
}

/** Socket authentication for a paired device. Each dial exchanges a fresh single-use ticket. */
export function pairedSocketCredential(options: {
  url: string;
  token(): Promise<string>;
  fetch: AccessOptions["fetch"];
}): () => Promise<{ ticket: string }> {
  const origin = new URL(options.url);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return ticketCredential(options.token, async (token) =>
    accessTicket({
      origin: `${origin.origin}/`,
      token: async () => token,
      fetch: options.fetch,
    }),
  );
}
