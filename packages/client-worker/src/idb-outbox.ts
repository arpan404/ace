import type { Storage } from "@ace/client";
import { Command } from "@ace/protocol";
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
      // Old tabs can keep their version-1 database open while the new adapter migrates it.
      const request = factory.open("ace-intents", 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore("intents");
        request.result.createObjectStore("migrated");
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    }));
  const transact = async <T>(
    mode: IDBTransactionMode,
    act: (tx: IDBTransaction, done: (value: T) => void) => void,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["intents", "migrated"], mode);
      let value: T;
      tx.addEventListener("complete", () => resolve(value));
      tx.addEventListener("error", () => reject(tx.error));
      tx.addEventListener("abort", () =>
        reject(tx.error ?? new Error("Outbox transaction aborted")),
      );
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
    let legacy = seed;
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("ace", 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore("outbox"));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    try {
      const saved: unknown = await new Promise((resolve, reject) => {
        const tx = old.transaction("outbox", "readonly");
        const request = tx.objectStore("outbox").get(key);
        tx.addEventListener("complete", () => resolve(request.result));
        tx.addEventListener("error", () => reject(tx.error));
        tx.addEventListener("abort", () => reject(tx.error));
      });
      if (typeof saved === "string") legacy = saved;
    } finally {
      old.close();
    }
    await transact<void>("readwrite", (tx, done) => {
      const markers = tx.objectStore("migrated");
      const read = markers.get(key);
      read.addEventListener("success", () => {
        try {
          if (!read.result) {
            const entries = z
              .array(z.object({ command: Command }).passthrough())
              .parse(JSON.parse(legacy ?? "[]"));
            for (const [order, entry] of entries.entries())
              tx.objectStore("intents").put(JSON.stringify({ ...entry, order }), [
                key,
                entry.command.id,
              ]);
            markers.put(true, key);
          }
          done(undefined);
        } catch {
          tx.abort();
        }
      });
    });
  };
  let migrated: Promise<void> | undefined;
  const ready = () => (migrated ??= migrate());
  return {
    records: {
      async load() {
        await ready();
        return transact<readonly string[]>("readonly", (tx, done) => {
          const request = tx
            .objectStore("intents")
            .getAll(IDBKeyRange.bound([key], [key, []], false, true));
          request.addEventListener("success", () => {
            try {
              done(z.array(z.string()).parse(request.result));
            } catch {
              tx.abort();
            }
          });
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
    async load() {
      throw new Error("Use record storage");
    },
    async save() {
      throw new Error("Use record storage");
    },
  };
}
