import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { CompactionInput } from "./compaction-protocol.ts";

const input = CompactionInput.parse(JSON.parse(process.argv[2] ?? "null"));
let result: "complete" | "deferred" = "deferred";
const db = new DatabaseSync(input.database);
try {
  db.exec("PRAGMA busy_timeout=0");
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count);
  if (input.availableBytes >= pages * pageSize * 3) {
    const mode = Number(db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum);
    if (mode === 2) db.exec("PRAGMA incremental_vacuum(256)");
    else db.exec("VACUUM");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy) === 0) result = "complete";
  }
} catch {
  /* Busy or interrupted compaction is deferred, never repaired speculatively. */
} finally {
  db.close();
}
process.stdout.write(JSON.stringify(result));
