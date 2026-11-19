import { relayRoute, webSocketTransport, type Credential, type Transport } from "@ace/client";
import { browserDeviceSocket } from "@ace/client/devices";
import type { DaemonTarget } from "./connection-settings.ts";
import { browserCredential } from "./remote-credential.ts";

const schedule = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * How a client reaches a daemon target: its own WebSocket, or, for a machine paired through a
 * self-hosted relay (`relayHostId`), a relay channel pinned to that host key whose hello carries
 * the paired device's token (ADR 0070). Each relay attempt dials and handshakes again.
 */
export function daemonRoute(target: DaemonTarget): {
  transport(): Transport;
  credential(): Promise<Credential>;
} {
  if (!target.relayHostId)
    return {
      transport: () => webSocketTransport(() => new WebSocket(target.url)),
      credential: browserCredential(target),
    };
  return relayRoute({
    relayUrl: target.url,
    hostId: target.relayHostId,
    credential: async () => target.token,
    socket: browserDeviceSocket,
    schedule,
  });
}
