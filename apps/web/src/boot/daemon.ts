import { webSocketTransport, type Client } from "@ace/client";
import { createBrowserClient, deviceId, localOutbox } from "./client.ts";
import type { DaemonTarget } from "./connection-settings.ts";

/** A client for a real daemon. The token stays in memory for the socket's hello. */
export function createDaemonClient(target: DaemonTarget): Client {
  const device = deviceId();
  return createBrowserClient({
    deviceId: device,
    transport: () => webSocketTransport(() => new WebSocket(target.url)),
    credential: async () => target.token,
    storage: localOutbox(`ace.outbox.${target.url}.${device}`),
  });
}
