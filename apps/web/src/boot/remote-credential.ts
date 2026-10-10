import type { Credential } from "@ace/client";
import type { DaemonTarget } from "./connection-settings.ts";

/** Access schemas load only for paired connections, keeping the local worker small. */
export function browserCredential(target: DaemonTarget): () => Promise<Credential> {
  return async () => {
    if (!target.pairedDeviceId) return target.token;
    const { socketTicket } = await import("@ace/client/access-call");
    const url = new URL(target.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const issued = await socketTicket({
      origin: `${url.origin}/`,
      fetch: (input, init) => fetch(input, init),
      token: async () => target.token,
    });
    return { ticket: issued.ticket };
  };
}
