import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { assertWireShape } from "@ace/provider-kit/wire-shape";
import { z } from "zod";
import {
  searchWireShape,
  type SearchWorkerData,
  type SearchWorkerRequest,
  type SearchWorkerResult,
} from "./worker-protocol.ts";
import { searchParsed } from "./query.ts";
import { Statements } from "./writer.ts";

// The daemon that started this worker built `workerData`; refuse one from another build.
const data = workerData as Partial<SearchWorkerData> | null;
assertWireShape("search", data?.shape, searchWireShape);
const path = z.string().min(1).parse(data?.path);
const port = parentPort;
if (!port) throw new Error("Search worker requires a parent");
const reply = (message: SearchWorkerResult) => port.postMessage(message);
const db = new DatabaseSync(path, { readOnly: true });
db.exec(
  "PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE",
);
const sql = new Statements(db);
const Meta = z.object({
  generation: z.number().int().nonnegative(),
  trigrams: z.number().int().min(0).max(1),
});
// Same build, checked above: the request is the daemon's typed message, its query validated.
port.on("message", ({ id, query }: SearchWorkerRequest) => {
  try {
    // Pin metadata, content, FTS statistics and cursor generation to one WAL snapshot.
    db.exec("BEGIN");
    const meta = Meta.parse(
      sql.get("SELECT generation,trigrams FROM search_meta WHERE id=1").get(),
    );
    const results = searchParsed(sql, query, meta.generation, meta.trigrams === 1);
    db.exec("COMMIT");
    reply({ id, ok: true, results });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    const message = error instanceof Error ? error.message : "search_failed";
    const code =
      message === "search_cursor_stale" || message === "search_invalid_query"
        ? message
        : "search_failed";
    reply({ id, ok: false, error: code });
  }
});
