import { computerName } from "../computer-name.ts";
import { hostname } from "node:os";
import { HostIdentity } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/** A bounded settings read. Provider discovery and other hosts are never consulted. */
export function createHostIdentitySession({
  options,
  authorize,
  connected,
  send,
  fail,
}: SocketContext): SocketService {
  let pending = false;
  const defaultName = options.hostName ? Promise.resolve(options.hostName) : computerName();
  return {
    handle(message) {
      if (message.type !== "host.identity") return false;
      if (!authorize("read") || pending) {
        fail(!authorize("read") ? "forbidden" : "busy", "Identity read unavailable", false, {
          requestId: message.requestId,
        });
        return true;
      }
      pending = true;
      void (async () => {
        try {
          const name = (await options.settings?.get("host.displayName"))?.value;
          const icon = await options.settings?.get("host.icon");
          const identity = HostIdentity.parse({
            hostId: options.hostId,
            displayName: name || (await defaultName),
            // Unset, clients pick the default mark: this machine a laptop, another a server.
            ...(icon && icon.provenance !== "defaults" ? { icon: icon.value } : {}),
            hostname: hostname(),
            version: options.version ?? "development",
          });
          if (connected() && authorize("read"))
            send({ type: "host.identity.result", requestId: message.requestId, identity });
        } catch {
          if (connected())
            fail("unavailable", "Identity read failed", false, { requestId: message.requestId });
        } finally {
          pending = false;
        }
      })();
      return true;
    },
  };
}
