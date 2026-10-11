import { ClientError, type Credential } from "@ace/client";
import { isLoopbackUrl } from "./fragment-handoff.ts";
import type { DaemonTarget } from "./connection-settings.ts";

/** Access schemas load only for paired connections, keeping the local worker small. */
export function browserCredential(target: DaemonTarget): () => Promise<Credential> {
  return async () => {
    if (!target.pairedDeviceId) {
      if (target.url.startsWith("wss:") || !isLoopbackUrl(target.url))
        throw new ClientError("auth", "Pair this device before connecting to a remote daemon.");
      return target.token;
    }
    const { pairedSocketCredential } = await import("@ace/client/access-ticket");
    return pairedSocketCredential({
      url: target.url,
      token: async () => target.token,
      fetch: (input, init) => fetch(input, init),
    })();
  };
}
