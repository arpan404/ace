import type { ClientApi } from "@ace/client";
import { RemoteClient, type PortLike } from "@ace/client-worker";
import type { DaemonTarget } from "./connection-settings.ts";
import { tabLiveness } from "./web-locks.ts";
import { outboxKey, type WorkerTarget } from "./worker-target.ts";

/**
 * A client whose connection, decoding, projection and outbox run in a worker (ADR 0056):
 * shared by all tabs through a SharedWorker, else one dedicated Worker per tab. Undefined
 * where neither exists, and the caller runs the client in the page.
 */
export function createWorkerClient(target: DaemonTarget, deviceId: string): ClientApi | undefined {
  const worker = workerPort();
  if (!worker) return undefined;
  const key = outboxKey({ url: target.url, deviceId });
  const config: WorkerTarget = { ...target, deviceId, seed: readLegacy(key) };
  const liveness = tabLiveness();
  return new RemoteClient(worker.port, config, {
    workerFailure: worker.failure,
    ...(liveness ? { liveness } : {}),
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
    attached: () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* Storage is denied: there is no old copy to clear. */
      }
    },
  });
}

let sharedFailed = false;
function workerPort():
  | { port: PortLike; failure: { watch(lost: () => void): () => void; close(): void } }
  | undefined {
  // Vite bundles each worker from these literal constructor calls.
  if (!sharedFailed && typeof SharedWorker === "function") {
    try {
      const worker = new SharedWorker(new URL("./client-worker.ts", import.meta.url), {
        type: "module",
        name: "ace-client",
      });
      return {
        port: worker.port,
        failure: {
          watch(lost) {
            const fail = () => {
              sharedFailed = true;
              lost();
            };
            worker.addEventListener("error", fail);
            worker.port.addEventListener("messageerror", fail);
            return () => {
              worker.removeEventListener("error", fail);
              worker.port.removeEventListener("messageerror", fail);
            };
          },
          close: () => worker.port.close(),
        },
      };
    } catch {
      sharedFailed = true;
    }
  }
  if (typeof Worker === "function") {
    const worker = new Worker(new URL("./client-worker.ts", import.meta.url), {
      type: "module",
      name: "ace-client",
    });
    return {
      port: worker,
      failure: {
        watch(lost) {
          worker.addEventListener("error", lost);
          worker.addEventListener("messageerror", lost);
          return () => {
            worker.removeEventListener("error", lost);
            worker.removeEventListener("messageerror", lost);
          };
        },
        close: () => worker.terminate(),
      },
    };
  }
  return undefined;
}

function readLegacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
