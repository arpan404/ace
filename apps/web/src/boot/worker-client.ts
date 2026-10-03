import type { ClientApi } from "@ace/client";
import { RemoteClient, type PortLike } from "@ace/client-worker";
import type { DaemonTarget } from "./connection-settings.ts";
import { outboxKey, type WorkerTarget } from "./worker-target.ts";

/**
 * A client whose connection, decoding, projection and outbox run in a worker (ADR 0050):
 * shared by all tabs through a SharedWorker, else one dedicated Worker per tab. Undefined
 * where neither exists, and the caller runs the client in the page.
 */
export function createWorkerClient(target: DaemonTarget, deviceId: string): ClientApi | undefined {
  const port = workerPort();
  if (!port) return undefined;
  const key = outboxKey({ url: target.url, deviceId });
  const config: WorkerTarget = { ...target, deviceId, seed: readLegacy(key) };
  return new RemoteClient(port, config, {
    scheduler: {
      set(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
    visibility: {
      visible: () => document.visibilityState === "visible",
      watch(changed) {
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
      },
    },
    // The worker now owns the outbox; the copy an older build kept here is spent.
    attached: () => localStorage.removeItem(key),
  });
}

function workerPort(): PortLike | undefined {
  // Vite bundles each worker from these literal constructor calls.
  if (typeof SharedWorker === "function") {
    const worker = new SharedWorker(new URL("./client-worker.ts", import.meta.url), {
      type: "module",
      name: "ace-client",
    });
    return worker.port;
  }
  if (typeof Worker === "function")
    return new Worker(new URL("./client-worker.ts", import.meta.url), {
      type: "module",
      name: "ace-client",
    });
  return undefined;
}

function readLegacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
