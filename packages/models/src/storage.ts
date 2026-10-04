import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { chmodSync } from "node:fs";
import { IdleWorker } from "@ace/provider-kit/idle-worker";
import { z } from "zod";
import { CachedEntry } from "./cache-schema.ts";
import type { CacheEntry, CatalogStorage } from "./types.ts";

const Reply = z.object({ id: z.number().int().positive(), ok: z.boolean() });
type Pending = { resolve: () => void; reject: (error: Error) => void; bytes: number };
/** Startup reads are synchronous; later writes run on a dedicated SQLite worker. */
export function openModelStorage(path: string): CatalogStorage {
  const db = new DatabaseSync(path);
  let entries: CacheEntry[];
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA cache_size=-512; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS model_catalog (instance TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    const rows = db
      .prepare(
        "SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 4194304 THEN payload ELSE NULL END AS payload FROM model_catalog LIMIT 65",
      )
      .all();
    if (rows.length > 64) throw new Error("Too many persisted instances");
    entries = rows.map((row) =>
      CachedEntry.parse(
        JSON.parse(
          z
            .string()
            .max(4 * 1024 * 1024)
            .parse(row["payload"]),
        ),
      ),
    );
  } finally {
    db.close();
  }
  const worker = new IdleWorker(new URL("./storage-worker.ts", import.meta.url), {
    workerData: { path },
  });
  const pending = new Map<number, Pending>();
  let pendingBytes = 0;
  let nextId = 1;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const fail = () => {
    failure ??= new Error("Model persistence worker failed");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    pendingBytes = 0;
  };
  worker.on("error", fail);
  worker.on("message", (value: unknown) => {
    const parsed = Reply.safeParse(value);
    if (!parsed.success) {
      fail();
      void worker.terminate();
      return;
    }
    const request = pending.get(parsed.data.id);
    pending.delete(parsed.data.id);
    if (request) pendingBytes -= request.bytes;
    if (parsed.data.ok) request?.resolve();
    else request?.reject(new Error("Model persistence failed"));
    if (!pending.size && path !== ":memory:") worker.idle();
  });
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", () => {
      fail();
      resolve();
    }),
  );
  const send = (operation: "replace" | "remove" | "close", data: unknown): Promise<void> => {
    if (closing && operation !== "close")
      return Promise.reject(new Error("Model persistence closed"));
    if (failure) return Promise.reject(failure);
    // The worker processes messages in order. Close is a barrier after all admitted writes,
    // with one reserved request outside the mutation admission limit.
    if (operation !== "close" && pending.size >= 128)
      return Promise.reject(new Error("Model persistence queue full"));
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(data));
    } catch {
      return Promise.reject(new Error("Model persistence failed"));
    }
    if (
      bytes > 4 * 1024 * 1024 ||
      (operation !== "close" && pendingBytes + bytes > 8 * 1024 * 1024)
    )
      return Promise.reject(new Error("Model persistence byte backpressure"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, bytes });
      pendingBytes += bytes;
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker, not a browser window.
        worker.postMessage({ id, operation, data });
      } catch {
        pending.delete(id);
        pendingBytes -= bytes;
        reject(new Error("Model persistence failed"));
      }
    });
  };
  return {
    load() {
      const loaded = entries;
      entries = [];
      return loaded;
    },
    replace(entry) {
      return send("replace", entry);
    },
    remove(instance) {
      return send("remove", instance);
    },
    close() {
      closing ??= (async () => {
        try {
          if (worker.started) await send("close", null);
        } finally {
          await worker.terminate();
          await exited;
          entries = [];
        }
      })();
      return closing;
    },
  };
}
