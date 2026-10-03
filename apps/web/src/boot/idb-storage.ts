import type { Storage } from "@ace/client";

/*
 * The intents outbox in IndexedDB, which workers can reach (localStorage they cannot). One
 * record per daemon and device; each save replaces it in one transaction, so a crash leaves
 * either the previous outbox or the new one.
 */

const database = "ace";
const store = "outbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(store));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB unavailable")),
    );
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  act: (objects: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = act(transaction.objectStore(store));
    transaction.addEventListener("complete", () => resolve(request.result));
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB write failed")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB write aborted")),
    );
  });
}

/**
 * The outbox for `key`. `seed` is an outbox an older build kept in localStorage; it is read
 * once when IndexedDB has none, so pending intents survive the move.
 */
export function idbOutbox(key: string, seed: string | null = null): Storage {
  let db: Promise<IDBDatabase> | undefined;
  const connection = () => (db ??= open());
  return {
    async load() {
      const value: unknown = await run(await connection(), "readonly", (objects) =>
        objects.get(key),
      );
      return typeof value === "string" ? value : seed;
    },
    async save(value) {
      await run(await connection(), "readwrite", (objects) => objects.put(value, key));
    },
  };
}
