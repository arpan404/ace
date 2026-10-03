/*
 * A persistent cache of derived data (diffs) in IndexedDB: survives reloads, bounded by entry
 * count, oldest-used entries pruned first. Failures (private mode, quota, no IndexedDB) make
 * it a cache that always misses; callers recompute.
 */

export interface PersistentCache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
}

interface Row {
  key: string;
  value: unknown;
  used: number;
}

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.addEventListener("success", () => resolve(target.result));
    target.addEventListener("error", () => reject(target.error ?? new Error("IndexedDB failed")));
  });
}

/**
 * `name` names the database; `decode` checks a stored value (it may come from an older build)
 * and throws if it does not fit. `now` stamps use for pruning.
 */
export function idbCache<V>(options: {
  name: string;
  maxEntries: number;
  decode: (value: unknown) => V;
  now: () => number;
}): PersistentCache<V> {
  const none: PersistentCache<V> = { get: async () => undefined, set: async () => {} };
  if (typeof indexedDB === "undefined") return none;
  let opened: Promise<IDBDatabase | undefined> | undefined;
  const database = () =>
    (opened ??= (async () => {
      try {
        const open = indexedDB.open(options.name, 1);
        open.addEventListener("upgradeneeded", () =>
          open.result.createObjectStore("entries", { keyPath: "key" }).createIndex("used", "used"),
        );
        return await request(open);
      } catch {
        return undefined;
      }
    })());
  let writes = 0;
  const prune = async (db: IDBDatabase) => {
    const store = db.transaction("entries", "readwrite").objectStore("entries");
    const excess = (await request(store.count())) - options.maxEntries;
    if (excess <= 0) return;
    const cursor = store.index("used").openCursor();
    let removed = 0;
    await new Promise<void>((resolve) => {
      cursor.addEventListener("success", () => {
        const at = cursor.result;
        if (!at || removed >= excess) return resolve();
        at.delete();
        removed++;
        at.continue();
      });
      cursor.addEventListener("error", () => resolve());
    });
  };
  return {
    async get(key) {
      try {
        const db = await database();
        if (!db) return undefined;
        const store = db.transaction("entries", "readwrite").objectStore("entries");
        const row: unknown = await request(store.get(key));
        if (!isRow(row)) return undefined;
        const value = options.decode(row.value);
        store.put({ ...row, used: options.now() });
        return value;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        const db = await database();
        if (!db) return;
        const store = db.transaction("entries", "readwrite").objectStore("entries");
        await request(store.put({ key, value, used: options.now() } satisfies Row));
        // Prune now and then, not on every write.
        if (++writes % 32 === 1) await prune(db);
      } catch {
        /* A cache that cannot store simply misses next time. */
      }
    },
  };
}

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && "key" in value && "value" in value;
