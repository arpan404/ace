/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { workerData, parentPort } from "node:worker_threads";
import { z } from "zod";
import { openArchiveReader } from "@ace/history-import";
import { Store } from "./store.ts";

const input = z
  .object({
    databasePath: z.string(),
    archivePath: z.string(),
    threadId: z.string(),
    at: z.number().int().nonnegative(),
    cancellation: z.custom<SharedArrayBuffer>(
      (v) => v instanceof SharedArrayBuffer && v.byteLength === 4,
    ),
  })
  .parse(workerData);
const cancelled = () => Atomics.load(new Int32Array(input.cancellation), 0) !== 0;
const store = new Store(input.databasePath);
const archive = openArchiveReader(input.archivePath, input.threadId);
try {
  store.installHistory(archive, input.at, cancelled);
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    reason: error instanceof Error ? error.message : "History publication failed",
  });
} finally {
  archive.close();
  store.close();
}
