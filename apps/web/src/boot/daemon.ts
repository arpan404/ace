import type { ClientApi } from "@ace/client";
import type { DaemonTarget } from "./connection-settings.ts";
import { deviceId } from "./device-id.ts";
import { createWorkerClient } from "./worker-client.ts";
import { outboxKey } from "./worker-target.ts";
import { authorizeDaemonUrl } from "./daemon-network.ts";

/**
 * A client for a real daemon: in the client worker where the browser has one (ADR 0056),
 * else in the page, once the in-page client has loaded. The token stays in memory for the
 * socket's hello.
 */
export async function createDaemonClient(target: DaemonTarget): Promise<ClientApi> {
  await authorizeDaemonUrl(target.url);
  const device = target.pairedDeviceId ?? deviceId();
  const worker = createWorkerClient(target, device);
  if (worker) return worker;
  const key = outboxKey({ ...target, deviceId: device });
  return import("./page-client.ts").then(({ createPageClient }) =>
    createPageClient(target, { deviceId: device, outboxKey: key }),
  );
}

/**
 * The person trusts the daemon now at `target`'s address, though it isn't the one this window
 * met there before: forget the old one's identity, the work saved for it, in both outboxes a
 * client may have used (the worker's IndexedDB one and the in-page one), and the threads read
 * from it.
 */
export async function forgetDaemonIdentity(target: DaemonTarget): Promise<void> {
  const device = target.pairedDeviceId ?? deviceId();
  const key = outboxKey({ ...target, deviceId: device });
  const [{ forgetIdbOutbox }, { forgetLocalOutbox }, { forgetReadSnapshots }] = await Promise.all([
    import("@ace/client-worker/idb-outbox"),
    import("./client.ts"),
    import("./read-snapshots.ts"),
  ]);
  if (typeof indexedDB !== "undefined") {
    await forgetIdbOutbox(key);
    // Records are filed under the host that served them, so the new daemon can't read these
    // either way: a failed delete leaves them to the cache's pruning, never blocks reconnecting.
    await forgetReadSnapshots({ ...target, deviceId: device }).catch((error: unknown) =>
      console.error("ace: couldn't delete the old daemon's cached threads", error),
    );
  }
  try {
    forgetLocalOutbox(key);
  } catch {
    /* Storage is denied: the in-page client kept nothing here. */
  }
}
