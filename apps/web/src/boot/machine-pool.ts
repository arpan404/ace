import { authorizeDaemonUrl } from "./daemon-network.ts";
import { machineSecrets } from "./machine-secrets.ts";
import { ClientError, type Storage } from "@ace/client";
import { MachineDirectory, type MachineEntry } from "@ace/client/machines";
import type { PortLike } from "@ace/client-worker";
import { MachinePool } from "@ace/client-worker/machines";
import type { KeyValueStorage } from "@ace/ui-core";
import type { MachineTarget } from "./machine-target.ts";
import { forgetReadSnapshots } from "./read-snapshots.ts";

/*
 * The browser's and desktop renderer's machine pool (ADR 0059): the directory of the person's
 * other machines and one dedicated client worker per machine. Loaded only when a directory is
 * stored or Settings adds a machine (`machine-pool-boot.ts`).
 */

/** Where the directory (no credentials) lives. */
export const directoryKey = "ace.machines";

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
function dedicatedWorker(name: string, url: string): SpawnedWorker {
  // Vite bundles the worker from this literal constructor call.
  const worker = new Worker(new URL("./machine-worker.ts", import.meta.url), {
    type: "module",
    name,
  });
  const failures = new Set<() => void>();
  let stopped = false;
  let failed = false;
  const fail = () => {
    failed = true;
    for (const listener of failures) listener();
  };
  worker.addEventListener("error", fail);
  worker.addEventListener("messageerror", fail);
  const ready = authorizeDaemonUrl(url).then(
    () => true,
    () => {
      fail();
      return false;
    },
  );
  return {
    port: {
      postMessage(message, transfer?: ArrayBuffer[]) {
        void ready.then((approved) => {
          if (approved && !stopped) worker.postMessage(message, transfer ?? []);
        });
      },
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    },
    terminate() {
      stopped = true;
      worker.terminate();
    },
    onError(listener) {
      failures.add(listener);
      if (failed)
        queueMicrotask(() => {
          if (!stopped && failures.has(listener)) listener();
        });
      return () => {
        failures.delete(listener);
      };
    },
  };
}

/** What a machine's worker is handed: the same connection its cached threads are filed under. */
function machineConfig(entry: MachineEntry, url: string, token: string): MachineTarget {
  return {
    url: socketUrl(url),
    token,
    deviceId: entry.deviceId,
    pairedDeviceId: entry.deviceId,
    seed: null,
    hostId: entry.hostId,
  };
}

/** A directory that, removing a machine, also deletes the threads read from it. */
class ForgettingDirectory extends MachineDirectory {
  override async remove(hostId: string): Promise<void> {
    const entry = (await this.load()).find((candidate) => candidate.hostId === hostId);
    const token = entry && (await this.token(entry).catch(() => undefined));
    await super.remove(hostId);
    if (entry?.target.kind !== "direct" || !token) return;
    await forgetReadSnapshots(machineConfig(entry, entry.target.url, token)).catch(
      (error: unknown) => console.error("ace: couldn't delete a removed machine's threads", error),
    );
  }
}

/**
 * The pool over the directory in `storage`. Each machine gets its own worker whose client is
 * pinned to the machine's host id and authenticates with the machine's own stored token.
 * Relay entries wait for the relay transport in the worker; they report offline meanwhile.
 */
export function browserMachinePool(options: {
  storage: KeyValueStorage;
  session?: KeyValueStorage;
  spawnWorker?: (name: string) => SpawnedWorker;
}): MachinePool {
  const directory = new ForgettingDirectory(
    directoryStorage(options.storage),
    machineSecrets(options.storage, options.session ?? sessionStorage),
    (work) => (navigator.locks ? navigator.locks.request("ace-machine-directory", work) : work()),
  );
  return new MachinePool({
    directory,
    remote: { scheduler: timers },
    spawn(entry, token) {
      if (entry.target.kind !== "direct")
        throw new ClientError("offline", "Relay machines aren't supported in this window yet");
      const worker = options.spawnWorker
        ? options.spawnWorker(`ace-machine-${entry.hostId}`)
        : dedicatedWorker(`ace-machine-${entry.hostId}`, entry.target.url);
      const config = machineConfig(entry, entry.target.url, token);
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
