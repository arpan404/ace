/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { workerData, parentPort } from "node:worker_threads";
import { z } from "zod";
import { openArchiveReader } from "@ace/history-import";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { runningBuildId, storedTrustBuild } from "./stored-shape.ts";

const input = z
  .object({
    databasePath: z.string(),
    archivePath: z.string(),
    threadId: z.string(),
    at: z.number().int().nonnegative(),
    storedTrustBuild: z.string().nullable(),
    cancellation: z.custom<SharedArrayBuffer>(
      (v) => v instanceof SharedArrayBuffer && v.byteLength === 4,
    ),
  })
  .parse(workerData);
const cancelled = () => Atomics.load(new Int32Array(input.cancellation), 0) !== 0;
// This file ships beside the daemon's entry and reads the same build id. Differing ones mean
// the release on disk changed under the running daemon: this code must not write its store.
const build = storedTrustBuild(
  process.env.ACE_VERSION,
  runningBuildId(dirname(fileURLToPath(import.meta.url))),
);
function publish(): void {
  // Reads the daemon's trust record and runs no idle pass of its own.
  const store = new Store(input.databasePath, console.error, {
    storedTrustBuild: build,
    storedTrustReader: true,
  });
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
    void store.close();
  }
}
if (build === (input.storedTrustBuild ?? undefined)) publish();
else
  parentPort?.postMessage({
    ok: false,
    reason: "ace was updated while running; restart it to publish this history",
  });
