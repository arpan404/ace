import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { CheckpointRequest, CheckpointWorkerData } from "./wal-checkpoint-protocol.ts";

// Checkpoints copy WAL frames into the database file and fsync it. On the store's own
// connection that fsync stalled the event loop inside whichever COMMIT crossed the threshold.
const { path } = CheckpointWorkerData.parse(workerData);
const port = parentPort;
if (!port) throw new Error("Checkpoint worker requires a parent");
const db = new DatabaseSync(path);
// This connection never writes rows. busy_timeout=0: a TRUNCATE that meets a writer gives up
// at once instead of holding the write lock the store is waiting for.
db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0");
const statements = {
  PASSIVE: db.prepare("PRAGMA wal_checkpoint(PASSIVE)"),
  TRUNCATE: db.prepare("PRAGMA wal_checkpoint(TRUNCATE)"),
};
port.on("message", (input: unknown) => {
  const request = CheckpointRequest.safeParse(input);
  if (!request.success) throw new Error("Invalid checkpoint request");
  const { id, mode } = request.data;
  try {
    const row = statements[mode].get();
    port.postMessage({ id, ok: true, busy: row?.["busy"] === 1 });
  } catch (error) {
    const busy =
      error instanceof Error &&
      "errcode" in error &&
      typeof error.errcode === "number" &&
      // SQLITE_BUSY or SQLITE_LOCKED, with any extended code.
      [5, 6].includes(error.errcode & 0xff);
    port.postMessage({
      id,
      ok: false,
      busy,
      error: error instanceof Error ? error.message : "checkpoint_failed",
    });
  }
});
