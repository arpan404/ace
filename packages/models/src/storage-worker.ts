import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { CachedEntry } from "./cache-schema.ts";

const port = parentPort;
if (!port) throw new Error("Persistence requires a worker port");
const { path } = z.object({ path: z.string().min(1).max(4096) }).parse(workerData);
const db = new DatabaseSync(path);
// :memory: creates a separate database in this thread.
db.exec(
  "PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS model_catalog (instance TEXT PRIMARY KEY, payload TEXT NOT NULL)",
);
// Capacity per kind, as the catalog holds rows (`catalog.ts` `kindLimit`): 64 CLI accounts and
// 512 ACP agents' rows. An ACP row is a short list, so it is held to a smaller payload.
const write = db.prepare(
  "INSERT INTO model_catalog(instance, payload) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM model_catalog WHERE instance=?1) OR (SELECT count(*) FROM model_catalog WHERE (json_extract(payload, '$.provider') = 'acp') = ?3) < ?4 ON CONFLICT(instance) DO UPDATE SET payload=excluded.payload",
);
const acpPayloadLimit = 256 * 1024;
const remove = db.prepare("DELETE FROM model_catalog WHERE instance=?");
const Request = z.object({
  id: z.number().int().positive(),
  operation: z.enum(["replace", "remove", "close"]),
  data: z.unknown(),
});
port.on("message", (value: unknown) => {
  const request = Request.parse(value);
  try {
    switch (request.operation) {
      case "replace": {
        const entry = CachedEntry.parse(request.data);
        const payload = JSON.stringify(entry);
        const acp = entry.provider === "acp";
        if (Buffer.byteLength(payload) > (acp ? acpPayloadLimit : 4 * 1024 * 1024))
          throw new Error("Cache entry exceeds limit");
        // Admission and replacement are one statement, so failed deletions keep their durable slot.
        if (write.run(entry.instance, payload, acp ? 1 : 0, acp ? 512 : 64).changes !== 1)
          throw new Error("Persisted instance limit reached");
        break;
      }
      case "remove":
        remove.run(z.string().min(1).max(256).parse(request.data));
        break;
      case "close":
        db.close();
        break;
    }
    port.postMessage({ id: request.id, ok: true });
  } catch {
    port.postMessage({ id: request.id, ok: false });
  }
  if (request.operation === "close") port.close();
});
