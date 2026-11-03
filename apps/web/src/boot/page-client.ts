import { browserReadSnapshots } from "./read-snapshots.ts";
import { daemonRoute } from "./daemon-route.ts";
import type { ClientApi } from "@ace/client";
import { createBrowserClient, localOutbox } from "./client.ts";
import type { DaemonTarget } from "./connection-settings.ts";
import { diagnosticsReporter } from "./diagnostics.ts";

/**
 * The client in the page, for browsers with neither SharedWorker nor Worker (ADR 0056). Loaded on
 * demand, so the page's first load carries neither `Client` nor the protocol's frame schemas.
 */
export function createPageClient(
  target: DaemonTarget,
  device: { deviceId: string; outboxKey: string },
): ClientApi {
  return createBrowserClient({
    report: diagnosticsReporter(),
    deviceId: device.deviceId,
    ...daemonRoute(target),
    storage: localOutbox(device.outboxKey),
    readSnapshots: browserReadSnapshots({ ...target, deviceId: device.deviceId }),
    expectedHostId: target.localHostId,
  });
}
