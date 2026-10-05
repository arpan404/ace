import type { Storage } from "@ace/client";
import { outboxKey, type WorkerTarget } from "./worker-target.ts";

/**
 * The client worker's outbox: one IndexedDB record per intent, scoped to the daemon and device
 * (`@ace/client-worker`'s record adapter, UX audit SY-5). Two workers or windows saving offline
 * sends each write their own record, so neither overwrites the other's. An outbox an older
 * build kept (in localStorage, or as one IndexedDB value) is carried over once. The adapter
 * (with the parsing its carry-over needs) loads on the outbox's first use, off the worker's
 * first script.
 */
export function workerOutbox(target: Pick<WorkerTarget, "url" | "deviceId" | "seed">): Storage {
  let adapter: Promise<Storage> | undefined;
  const records = async () => {
    adapter ??= import("@ace/client-worker/idb-outbox").then(({ idbOutbox }) =>
      idbOutbox(outboxKey(target), target.seed),
    );
    const loaded = (await adapter).records;
    if (!loaded) throw new Error("The outbox adapter keeps no records");
    return loaded;
  };
  return {
    records: {
      load: async () => (await records()).load(),
      write: async (id, value) => (await records()).write(id, value),
    },
    load: async () => {
      throw new Error("The worker outbox keeps one record per intent");
    },
    save: async () => {
      throw new Error("The worker outbox keeps one record per intent");
    },
  };
}
