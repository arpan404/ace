import type { Storage } from "@ace/client";
import { z } from "zod";

/** One record per intent, scoped by daemon and device. Inject the browser factory for tests. */
export function idbOutbox(
  key: string,
  seed: string | null = null,
  factory: IDBFactory = indexedDB,
): Storage {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      // Separate database: old tabs can keep their version-1 ace database open during migration.
      const request = factory.open("ace-intents", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("intents");
        request.result.createObjectStore("migrated");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const range = () => IDBKeyRange.bound([key, ""], [key, "\uffff"]);
  const transact = async <T>(
    mode: IDBTransactionMode,
    act: (tx: IDBTransaction, done: (value: T) => void) => void,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["intents", "migrated"], mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Outbox transaction aborted"));
      try {
        act(tx, (next) => {
          value = next;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  };
  const migrate = async () => {
    // Copy the old aggregate only once, in the same transaction as its migration marker.
    let legacy = seed;
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("ace", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("outbox");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const saved: unknown = await new Promise((resolve, reject) => {
        const tx = old.transaction("outbox", "readonly");
        const request = tx.objectStore("outbox").get(key);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
      if (typeof saved === "string") legacy = saved;
    } finally {
      old.close();
    }
    await transact<void>("readwrite", (tx, done) => {
      const markers = tx.objectStore("migrated");
      const read = markers.get(key);
      read.onsuccess = () => {
        if (!read.result) {
          const entries = z
            .array(z.object({ command: z.object({ id: z.string() }) }).passthrough())
            .parse(JSON.parse(legacy ?? "[]"));
          for (const entry of entries)
            tx.objectStore("intents").put(JSON.stringify(entry), [key, entry.command.id]);
          markers.put(true, key);
        }
        done(undefined);
      };
    });
  };
  let migrated: Promise<void> | undefined;
  const ready = () => (migrated ??= migrate());
  return {
    records: {
      async load() {
        await ready();
        return transact<readonly string[]>("readonly", (tx, done) => {
          const request = tx.objectStore("intents").getAll(range());
          request.onsuccess = () => done(z.array(z.string()).parse(request.result));
        });
      },
      async write(id, value) {
        await ready();
        await transact<void>("readwrite", (tx, done) => {
          const store = tx.objectStore("intents");
          if (value === null) store.delete([key, id]);
          else store.put(value, [key, id]);
          done(undefined);
        });
      },
    },
    // Only the record API is used by Client. No aggregate writes are permitted.
    async load() {
      throw new Error("Use record storage");
    },
    async save() {
      throw new Error("Use record storage");
    },
  };
}
