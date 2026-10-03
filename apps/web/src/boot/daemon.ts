import { webSocketTransport, type ClientApi } from "@ace/client";
import { createBrowserClient, deviceId, localOutbox } from "./client.ts";
import type { DaemonTarget } from "./connection-settings.ts";
import { createWorkerClient } from "./worker-client.ts";
import { outboxKey } from "./worker-target.ts";

/**
 * A client for a real daemon: in the client worker where the browser has one (ADR 0050),
 * else in the page. The token stays in memory for the socket's hello.
 */
export function createDaemonClient(target: DaemonTarget): ClientApi {
  const device = deviceId();
  return (
    createWorkerClient(target, device) ??
    createBrowserClient({
      deviceId: device,
      transport: () => webSocketTransport(() => new WebSocket(target.url)),
      credential: async () => target.token,
      storage: localOutbox(outboxKey({ url: target.url, deviceId: device })),
    })
  );
}
