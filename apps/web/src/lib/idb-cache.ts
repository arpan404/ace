/*
 * A persistent cache of derived data (diffs) in IndexedDB: survives reloads, bounded by entry
 * count and by bytes, least recently used entries pruned first. Values live in one store and a
 * small record of each entry's size and last use in another, so reads stay read-only, use is
 * stamped in batches and pruning walks the small records rather than the values. Failures
 * (private mode, quota, no IndexedDB) make it a cache that always misses; callers recompute.
 */

export interface PersistentCache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
}

interface Usage {
  key: string;
  used: number;
  bytes: number;
}

/**
 * Which entries to keep, fed newest use first: an entry is kept while the ones kept so far,
 * itself included, fit both limits. Everything after the first that doesn't fit is pruned.
 */
export function retention(limits: { maxEntries: number; maxBytes: number }) {
  let entries = 0;
  let bytes = 0;
  let full = false;
  return (size: number): boolean => {
    if (full) return false;
    if (entries + 1 > limits.maxEntries || bytes + size > limits.maxBytes) {
      full = true;
      return false;
    }
    entries++;
    bytes += size;
    return true;
  };
}

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

const isUsage = (value: unknown): value is Usage =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  typeof value.key === "string" &&
  "bytes" in value &&
  typeof value.bytes === "number";

/** Version 2 keeps sizes and use apart from values; an older cache is simply dropped. */
const version = 2;

/**
 * `name` names the database; `decode` checks a stored value (it may come from an older build)
 * and throws if it does not fit; `weigh` estimates a value's bytes. `now` stamps use; `later`
 * runs the batched bookkeeping (use stamps and pruning) a little after the latest activity.
 */
export function idbCache<V>(options: {
  name: string;
  maxEntries: number;
  maxBytes: number;
  decode: (value: unknown) => V;
  weigh: (value: V) => number;
  now: () => number;
  later?: (task: () => void) => void;
}): PersistentCache<V> {
  const none: PersistentCache<V> = { get: async () => undefined, set: async () => {} };
  if (typeof indexedDB === "undefined") return none;
  const later = options.later ?? ((task) => void setTimeout(task, 2_000));
  let opened: Promise<IDBDatabase | undefined> | undefined;
  const database = () =>
    (opened ??= (async () => {
      try {
        const open = indexedDB.open(options.name, version);
        open.addEventListener("upgradeneeded", () => {
          const db = open.result;
          for (const store of Array.from(db.objectStoreNames)) db.deleteObjectStore(store);
          db.createObjectStore("values");
          db.createObjectStore("usage", { keyPath: "key" }).createIndex("used", "used");
        });
        return await request(open);
      } catch {
        return undefined;
      }
    })());

  /** Keys read since the last flush, with when; written in one transaction. */
  const touched = new Map<string, number>();
  let wrote = false;
  let flushing = false;
  const flush = async () => {
    flushing = false;
    const db = await database();
    if (!db) return;
    const stamps = [...touched];
    touched.clear();
    const prune = wrote;
    wrote = false;
    try {
      const transaction = db.transaction(["values", "usage"], "readwrite");
      const usage = transaction.objectStore("usage");
      for (const [key, used] of stamps) {
        const row: unknown = await request(usage.get(key));
        if (isUsage(row)) usage.put({ ...row, used } satisfies Usage);
      }
      if (prune) await pruneIn(transaction);
      await done(transaction);
    } catch {
      /* Bookkeeping is best effort; the next flush tries again. */
    }
  };
  const schedule = () => {
    if (flushing) return;
    flushing = true;
    later(() => void flush());
  };
  /** Newest use first, keep what fits; delete the rest (value and record). */
  const pruneIn = async (transaction: IDBTransaction) => {
    const usage = transaction.objectStore("usage");
    const values = transaction.objectStore("values");
    const keep = retention(options);
    const cursor = usage.index("used").openCursor(null, "prev");
    await new Promise<void>((resolve) => {
      cursor.addEventListener("success", () => {
        const at = cursor.result;
        if (!at) return resolve();
        const row: unknown = at.value;
        if (!isUsage(row) || !keep(row.bytes)) {
          values.delete(at.primaryKey);
          at.delete();
        }
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
        const stored: unknown = await request(
          db.transaction("values", "readonly").objectStore("values").get(key),
        );
        if (stored === undefined) return undefined;
        const value = options.decode(stored);
        touched.set(key, options.now());
        schedule();
        return value;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        const db = await database();
        if (!db) return;
        const bytes = options.weigh(value);
        // Never stored: it would only push out everything else.
        if (bytes > options.maxBytes) return;
        const transaction = db.transaction(["values", "usage"], "readwrite");
        transaction.objectStore("values").put(value, key);
        transaction.objectStore("usage").put({ key, used: options.now(), bytes } satisfies Usage);
        await done(transaction);
        wrote = true;
        schedule();
      } catch {
        /* A cache that cannot store simply misses next time. */
      }
    },
  };
}
