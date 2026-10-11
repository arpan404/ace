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
  section<T>() {
    const prefix = `${++this.serial}:`;
    const entries = this.entries;
    return {
      get(key: string): CachedRecord<T> | undefined {
        // Values enter only through this section's T-typed set method.
        return entries.get(prefix + key) as CachedRecord<T> | undefined;
      },
      set(key: string, value: CachedRecord<T>, bytes: number) {
        // Charge decoded strings as well as the retained JSON.
        entries.set(prefix + key, value, bytes * 4);
      },
      delete(key: string) {
        entries.delete(prefix + key);
      },
    };
  }
}

export interface RecordTransaction {
  readonly tracking: boolean;
  touch(section: { flush(): void }): void;
}
