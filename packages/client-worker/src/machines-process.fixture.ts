/** Pool test boundary: real workers, bounded observation and injected persistence. */
import { Worker } from "node:worker_threads";
import { ClientError, type Selection } from "@ace/client";
import {
  MachineDirectory,
  machineThreadKey,
  type MachineEntry,
  type PairedMachine,
} from "@ace/client/machines";
import { HostId, ThreadId, WorkspaceId } from "@ace/protocol";
import { z } from "zod";
import { MachinePool, type MachineWorker } from "./machines.ts";

export const cleanup: (() => Promise<unknown>)[] = [];
export const scheduler = {
  set(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
export function wait<T>(
  selection: Selection<T>,
  predicate: (value: T) => boolean,
  ms = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("Observable deadline exceeded"));
    }, ms);
    const check = () => {
      const value = selection.getSnapshot();
      if (predicate(value)) {
        clearTimeout(timer);
        stop();
        resolve(value);
      }
    };
    const stop = selection.subscribe(check);
    check();
  });
}
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Independent machine stalled")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export function paired(hostId: string, name = hostId, token = "a".repeat(64)): PairedMachine {
  return {
    identity: { hostId: HostId.parse(hostId), displayName: name, version: "fake" },
    target: { kind: "direct", url: `ws://${hostId}.test/` },
    deviceId: "device",
    token,
  };
}
export function persistence() {
  let raw: string | null = null;
  const tokens = new Map<string, string>();
  const storage = {
    load: async () => raw,
    save: async (value: string) => {
      raw = value;
    },
  };
  const secrets = {
    get: async (key: string) => tokens.get(key) ?? null,
    set: async (key: string, value: string) => {
      tokens.set(key, value);
    },
    delete: async (key: string) => {
      tokens.delete(key);
    },
  };
  return {
    directory: new MachineDirectory(storage, secrets),
    storage,
    secrets,
    tokens,
    raw: () => raw,
  };
}
export function poolWorld(options: { threadCount?: number; outboxRoot?: string } = {}) {
  const p = persistence();
  const workers = new Map<string, Worker>();
  const sidebarFaults = new Map<string, "hold" | "fail">();
  const gates = new Map<string, Int32Array>();
  let controlId = 0;
  const pool = new MachinePool({
    directory: p.directory,
    remote: { scheduler },
    spawn(entry: MachineEntry, token: string): MachineWorker {
      const gate = new SharedArrayBuffer(4);
      gates.set(entry.hostId, new Int32Array(gate));
      const worker = new Worker(new URL("./machines-worker.fixture.ts", import.meta.url), {
        workerData: {
          hostId: entry.hostId,
          name: entry.displayName,
          token,
          sidebarFault: sidebarFaults.get(entry.hostId),
          gate,
          threadCount: options.threadCount,
          outboxRoot: options.outboxRoot,
        },
        execArgv: [],
      });
      workers.set(entry.hostId, worker);
      cleanup.push(() => worker.terminate());
      const listeners = new Map<(event: { data: unknown }) => void, (data: unknown) => void>();
      return {
        onFailure(listener) {
          const failed = () => listener(new ClientError("daemon", "Worker stopped"));
          worker.on("error", failed);
          worker.on("exit", failed);
          return () => {
            worker.off("error", failed);
            worker.off("exit", failed);
          };
        },
        config: {},
        terminate() {
          void worker.terminate();
        },
        port: {
          postMessage(value) {
            // A Node worker is a dedicated channel and has no target origin.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            worker.postMessage(value);
          },
          addEventListener(_type, listener) {
            const receive = (data: unknown) => listener({ data });
            listeners.set(listener, receive);
            worker.on("message", receive);
          },
          removeEventListener(_type, listener) {
            const receive = listeners.get(listener);
            if (receive) worker.off("message", receive);
            listeners.delete(listener);
          },
        },
      };
    },
  });
  cleanup.push(() => pool.close());
  return {
    ...p,
    pool,
    workers,
    sidebarFaults,
    unblock(hostId: string) {
      const gate = gates.get(hostId);
      if (!gate) throw new Error("Missing worker gate");
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    },
    async control(hostId: string, control: string) {
      const worker = workers.get(hostId);
      if (!worker) throw new Error("Missing worker");
      const id = ++controlId;
      const ack = new Promise<void>((resolve) => {
        const listener = (value: unknown) => {
          const parsed = z.object({ controlAck: z.number() }).safeParse(value);
          if (parsed.success && parsed.data.controlAck === id) {
            worker.off("message", listener);
            resolve();
          }
        };
        worker.on("message", listener);
      });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage({ control, id });
      await bounded(ack, 2000);
    },
  };
}
export const ref = (hostId: string, threadId = "shared") => ({ hostId, threadId });
export const key = (hostId: string, threadId = "shared") => machineThreadKey(ref(hostId, threadId));
export const create = (id: string) => ({
  type: "thread.create" as const,
  threadId: ThreadId.parse(id),
  workspaceId: WorkspaceId.parse("project"),
  provider: "codex" as const,
  input: [{ type: "text" as const, text: "Synthetic" }],
});
