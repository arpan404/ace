import { ClientError, type Storage } from "@ace/client";
import { MachineDirectory, type MachineSecretStore } from "@ace/client/machines";
import type { PortLike } from "@ace/client-worker";
import { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import type { MachineTarget } from "./worker-target.ts";

/*
 * The browser's and desktop renderer's machine pool (ADR 0059): the directory of the person's
 * other machines and one dedicated client worker per machine. Loaded only when a directory is
 * stored (`machine-pool-boot.ts`), so a window with one daemon carries none of it.
 */

/** Where the directory (no credentials) lives. */
export const directoryKey = "ace.machines";
const tokenKey = (key: string) => `ace.machines.token.${key}`;

/** A dedicated worker running `machine-worker.ts`, as the pool needs it. */
export interface SpawnedWorker {
  port: PortLike;
  terminate(): void;
  /** Called when the worker dies or can't load; returns the unsubscribe. */
  onError(listener: () => void): () => void;
}

function directoryStorage(storage: KeyValueStorage): Storage {
  return {
    load: async () => storage.getItem(directoryKey),
    save: async (value) => storage.setItem(directoryKey, value),
  };
}

/**
 * Device tokens kept the way this browser remembers its own daemon's: in local storage, apart
 * from the directory. The desktop keychain bridge replaces this (ADR 0059 follow-up).
 */
function rememberedTokens(storage: KeyValueStorage): MachineSecretStore {
  return {
    get: async (key) => storage.getItem(tokenKey(key)),
    set: async (key, token) => storage.setItem(tokenKey(key), token),
    delete: async (key) => storage.removeItem?.(tokenKey(key)),
  };
}

/** A directory URL as the socket address the client worker dials. */
function socketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString();
}

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** One dedicated client worker per machine; never shared between machines. */
function dedicatedWorker(name: string): SpawnedWorker {
  // Vite bundles the worker from this literal constructor call.
  const worker = new Worker(new URL("./machine-worker.ts", import.meta.url), {
    type: "module",
    name,
  });
  return {
    port: worker,
    terminate: () => worker.terminate(),
    onError(listener) {
      worker.addEventListener("error", listener);
      worker.addEventListener("messageerror", listener);
      return () => {
        worker.removeEventListener("error", listener);
        worker.removeEventListener("messageerror", listener);
      };
    },
  };
}

/**
 * The pool over the directory in `storage`. Each machine gets its own worker whose client is
 * pinned to the machine's host id and authenticates with the machine's own stored token.
 * Relay entries wait for the relay transport in the worker; they report offline meanwhile.
 */
export function browserMachinePool(options: {
  storage: KeyValueStorage;
  spawnWorker?: (name: string) => SpawnedWorker;
}): MachinePool {
  const spawnWorker = options.spawnWorker ?? dedicatedWorker;
  const directory = new MachineDirectory(
    directoryStorage(options.storage),
    rememberedTokens(options.storage),
  );
  return new MachinePool({
    directory,
    remote: { scheduler: timers },
    spawn(entry, token) {
      if (entry.target.kind !== "direct")
        throw new ClientError("offline", "Relay machines aren't supported in this window yet");
      const worker = spawnWorker(`ace-machine-${entry.hostId}`);
      const config: MachineTarget = {
        url: socketUrl(entry.target.url),
        token,
        deviceId: entry.deviceId,
        seed: null,
        hostId: entry.hostId,
      };
      return {
        port: worker.port,
        config,
        terminate: worker.terminate,
        onFailure: (listener) =>
          worker.onError(() => listener(new ClientError("offline", "Machine worker stopped"))),
      };
    },
  });
}
