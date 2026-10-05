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
          const identity = HostIdentity.parse({
            hostId: options.hostId,
            displayName: name || options.hostName || hostname(),
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
