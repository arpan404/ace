import type { ClientApi } from "@ace/client";
import type { DaemonTarget } from "./connection-settings.ts";
import { deviceId } from "./device-id.ts";
import { createWorkerClient } from "./worker-client.ts";
import { outboxKey } from "./worker-target.ts";

/**
 * A client for a real daemon: in the client worker where the browser has one (ADR 0056),
 * else in the page, once the in-page client has loaded. The token stays in memory for the
 * socket's hello.
 */
export function createDaemonClient(target: DaemonTarget): ClientApi | Promise<ClientApi> {
  const device = deviceId();
  const worker = createWorkerClient(target, device);
  if (worker) return worker;
  const key = outboxKey({ url: target.url, deviceId: device });
  return import("./page-client.ts").then(({ createPageClient }) =>
    createPageClient(target, { deviceId: device, outboxKey: key }),
  );
}
