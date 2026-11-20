import { z } from "zod";
import type { BufferKey, Draft, DraftStore } from "./types.ts";

/*
 * Drafts on the device (spec 53): one IndexedDB store keyed by [checkout, path], with an index
 * by checkout for reopening files. Unlike a cache, a failed write rejects, so the buffer can say
 * its draft isn't kept and quitting can ask (spec 50).
 */

const Row = z.object({
  root: z.string(),
  path: z.string(),
  text: z.string(),
  original: z.string(),
  version: z.string(),
});

const store = "drafts";

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.addEventListener("success", () => resolve(target.result));
    target.addEventListener("error", () => reject(target.error ?? new Error("IndexedDB failed")));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

const draftOf = (row: z.infer<typeof Row>): Draft => ({
  text: row.text,
  original: row.original,
  version: row.version,
});

/** Runs `run` in a readwrite transaction made now; resolves once it commits. */
function commit(db: IDBDatabase, run: (target: IDBObjectStore) => void): Promise<void> {
  try {
    const transaction = db.transaction(store, "readwrite");
    const committed = done(transaction);
    run(transaction.objectStore(store));
    return committed;
  } catch (error) {
    return Promise.reject(error);
  }
}

export function deviceDrafts(name = "ace.editor-drafts"): DraftStore {
  let opened: Promise<IDBDatabase> | undefined;
  /** The open database, once there is one: writes to it start in the caller's own task. */
  let current: IDBDatabase | undefined;
  const forget = () => {
    current = undefined;
    opened = undefined;
  };
  const database = () => {
    if (typeof indexedDB === "undefined")
      return Promise.reject(new Error("This browser can't keep drafts."));
    opened ??= (async () => {
      const open = indexedDB.open(name, 1);
      open.addEventListener("upgradeneeded", () => {
        open.result
          .createObjectStore(store, { keyPath: ["root", "path"] })
          .createIndex("root", "root");
      });
      const db = await request(open);
      db.addEventListener("close", forget);
      // Another page upgrading the database: let it, and open again on the next write.
      db.addEventListener("versionchange", () => {
        db.close();
        forget();
      });
      current = db;
      return db;
    })();
    opened.catch(forget);
    return opened;
  };
  // A page that is hiding gets no task after its handler, so an open database takes the write
  // at once. Either way transactions are made in call order, which IndexedDB keeps.
  const write = (run: (target: IDBObjectStore) => void): Promise<void> =>
    current ? commit(current, run) : database().then((db) => commit(db, run));
  return {
    async get(key: BufferKey) {
      const db = await database();
      const row = Row.safeParse(
        await request(db.transaction(store).objectStore(store).get([key.root, key.path])),
      );
      return row.success ? draftOf(row.data) : undefined;
    },
    put: (key, draft) => write((target) => target.put({ ...key, ...draft })),
    delete: (key) => write((target) => target.delete([key.root, key.path])),
    async list(root) {
      const db = await database();
      const rows: unknown[] = await request(
        db.transaction(store).objectStore(store).index("root").getAll(root),
      );
      return rows.flatMap((value) => {
        const row = Row.safeParse(value);
        return row.success ? [{ path: row.data.path, draft: draftOf(row.data) }] : [];
      });
    },
  };
}
