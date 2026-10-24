import { BoundedCache } from "@ace/provider-kit/bounded-cache";
export interface CachedRecord<T> {
  value: T;
  json: string;
  bytes: number;
}
/** Shared across every resident snapshot; keys never cross a section's typed owner. */
export class RecordBudget {
  private readonly entries = new BoundedCache<string, CachedRecord<unknown>>(8192, 8_388_608);
  private serial = 0;
  section<T>(): RecordSection<T> {
    const prefix = `${++this.serial}:`;
    const entries = this.entries;
    // Keys this section has cached; an evicted key just makes its delete a no-op.
    const keys = new Set<string>();
    return {
      get(key: string): CachedRecord<T> | undefined {
        // Values enter only through this section's T-typed set method.
        return entries.get(prefix + key) as CachedRecord<T> | undefined;
      },
      set(key: string, value: CachedRecord<T>, bytes: number) {
        keys.add(key);
        // Charge decoded strings as well as the retained JSON.
        entries.set(prefix + key, value, bytes * 4);
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
