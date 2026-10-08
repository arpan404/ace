import type { Credential } from "@ace/client";
import type { DaemonTarget } from "./connection-settings.ts";

/** Access schemas load only for paired connections, keeping the local worker small. */
export function browserCredential(target: DaemonTarget): () => Promise<Credential> {
  return async () => {
    if (!target.pairedDeviceId) return target.token;
    const { AccessClient } = await import("@ace/client/access");
    const url = new URL(target.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const access = new AccessClient({
      origin: `${url.origin}/`,
      fetch: (input, init) => fetch(input, init),
      token: async () => target.token,
    });
    return { ticket: (await access.ticket()).ticket };
  };
}
