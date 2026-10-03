import { webSocketTransport, type ClientApi } from "@ace/client";
import { createBrowserClient, localOutbox } from "./client.ts";
import type { DaemonTarget } from "./connection-settings.ts";

/**
 * The client in the page, for browsers with neither SharedWorker nor Worker (ADR 0056). Loaded on
 * demand, so the page's first load carries neither `Client` nor the protocol's frame schemas.
 */
export function createPageClient(
  target: DaemonTarget,
  device: { deviceId: string; outboxKey: string },
): ClientApi {
  return createBrowserClient({
    deviceId: device.deviceId,
    transport: () => webSocketTransport(() => new WebSocket(target.url)),
    credential: async () => target.token,
    storage: localOutbox(device.outboxKey),
  });
}
