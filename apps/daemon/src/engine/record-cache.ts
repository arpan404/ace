import { BoundedCache } from "@ace/provider-kit/bounded-cache";
export interface CachedRecord<T> {
  value: T;
  json: string;
  bytes: number;
}
/** A cached record and the section bookkeeping that must forget it when the budget evicts it. */
interface Entry {
  record: CachedRecord<unknown>;
  owner: Set<string>;
  key: string;
}
/** Shared across every resident snapshot; keys never cross a section's typed owner. */
export class RecordBudget {
  private readonly entries: BoundedCache<string, Entry>;
  private serial = 0;
  constructor(maxEntries = 8192, maxBytes = 8_388_608) {
    this.entries = new BoundedCache<string, Entry>(maxEntries, maxBytes, (_key, entry) =>
      entry.owner.delete(entry.key),
    );
  }
  section<T>(): RecordSection<T> {
    const prefix = `${++this.serial}:`;
    const entries = this.entries;
    // Exactly this section's keys still in the cache, so it stays within the shared budget.
    const keys = new Set<string>();
    return {
      get(key: string): CachedRecord<T> | undefined {
        // Values enter only through this section's T-typed set method.
        return entries.get(prefix + key)?.record as CachedRecord<T> | undefined;
      },
      set(key: string, value: CachedRecord<T>, bytes: number) {
        keys.delete(key);
        // Charge decoded strings as well as the retained JSON.
        if (entries.set(prefix + key, { record: value, owner: keys, key }, bytes * 4))
          keys.add(key);
      },
      delete(key: string) {
        keys.delete(key);
        entries.delete(prefix + key);
      },
      clear() {
        for (const key of keys) entries.delete(prefix + key);
        keys.clear();
      },
    };
  }
}

export interface RecordSection<T> {
  get(key: string): CachedRecord<T> | undefined;
  set(key: string, value: CachedRecord<T>, bytes: number): void;
  delete(key: string): void;
  /** Drops every entry this section cached. */
  clear(): void;
}

/** A released section caches nothing; its reads go to SQLite. */
export const uncachedSection: RecordSection<never> = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
  clear: () => {},
};

export interface RecordTransaction {
  readonly tracking: boolean;
  touch(section: { flush(): void; persist(): void; committed(): void }): void;
}
