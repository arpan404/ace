import type { Storage } from "@ace/client";
import { idbOutbox } from "@ace/client-worker";
import { outboxKey, type WorkerTarget } from "./worker-target.ts";

/**
 * The client worker's outbox: one IndexedDB record per intent, scoped to the daemon and device
 * (`@ace/client-worker`'s record adapter, UX audit SY-5). Two workers or windows saving offline
 * sends each write their own record, so neither overwrites the other's. An outbox an older
 * build kept (in localStorage, or as one IndexedDB value) is carried over once.
 */
export function workerOutbox(target: Pick<WorkerTarget, "url" | "deviceId" | "seed">): Storage {
  return idbOutbox(outboxKey(target), target.seed);
}
