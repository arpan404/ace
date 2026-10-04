import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SearchWorkerData, SearchWorkerRequest } from "./worker-protocol.ts";
import { querySearch } from "./query.ts";
import { Statements } from "./writer.ts";

const { path } = SearchWorkerData.parse(workerData);
const port = parentPort;
if (!port) throw new Error("Search worker requires a parent");
const db = new DatabaseSync(path, { readOnly: true });
db.exec(
  "PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE",
);
const sql = new Statements(db);
const Meta = z.object({
  generation: z.number().int().nonnegative(),
  trigrams: z.number().int().min(0).max(1),
});
port.on("message", (input: unknown) => {
  const request = SearchWorkerRequest.safeParse(input);
  if (!request.success) throw new Error("Invalid search worker request");
  const { id, query } = request.data;
  try {
    // Pin metadata, content, FTS statistics and cursor generation to one WAL snapshot.
    db.exec("BEGIN");
    const meta = Meta.parse(
      sql.get("SELECT generation,trigrams FROM search_meta WHERE id=1").get(),
    );
    const results = querySearch(sql, query, meta.generation, meta.trigrams === 1);
    db.exec("COMMIT");
    port.postMessage({ id, ok: true, results });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    const message = error instanceof Error ? error.message : "search_failed";
    const code =
      message === "search_cursor_stale" || message === "search_invalid_query"
        ? message
        : "search_failed";
    port.postMessage({ id, ok: false, error: code });
  }
});
