import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { CachedEntry } from "./cache-schema.ts";
import type { CacheEntry, CatalogStorage } from "./types.ts";

const Reply = z.object({ id: z.number().int().positive(), ok: z.boolean() });
type Pending = { resolve: () => void; reject: (error: Error) => void };
/** Startup reads are synchronous; later writes run on a dedicated SQLite worker. */
export function openModelStorage(path: string): CatalogStorage {
  const db = new DatabaseSync(path);
  let entries: CacheEntry[];
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS model_catalog (instance TEXT PRIMARY KEY, payload TEXT NOT NULL)",
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
  const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), {
    workerData: { path },
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const fail = () => {
    failure ??= new Error("Model persistence worker failed");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
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
    if (parsed.data.ok) request?.resolve();
    else request?.reject(new Error("Model persistence failed"));
  });
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", () => {
      fail();
      resolve();
    }),
  );
  const send = (operation: "replace" | "remove" | "close", data: unknown): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (pending.size >= 128) return Promise.reject(new Error("Model persistence queue full"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker, not a browser window.
        worker.postMessage({ id, operation, data });
      } catch {
        pending.delete(id);
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
          await send("close", null);
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
