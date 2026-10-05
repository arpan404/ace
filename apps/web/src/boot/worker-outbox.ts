import type { Storage } from "@ace/client";
import { idbOutbox } from "@ace/client-worker/idb-outbox";
import { outboxKey, type WorkerTarget } from "./worker-target.ts";

/**
 * The client worker's outbox: one IndexedDB record per intent, scoped to the daemon and device
 * (`@ace/client-worker`'s record adapter, UX audit SY-5). Two workers or windows saving offline
 * sends each write their own record, so neither overwrites the other's. An outbox an older
 * build kept (in localStorage, or as one IndexedDB value) is carried over once, on first use.
 * The adapter is part of the worker's first script: as a lazy chunk it cost more in chunk
 * overhead than it saved, and the worker's total with its lazy chunks is the tight budget.
 */
export function workerOutbox(target: Pick<WorkerTarget, "url" | "deviceId" | "seed">): Storage {
  return idbOutbox(outboxKey(target), target.seed);
}
