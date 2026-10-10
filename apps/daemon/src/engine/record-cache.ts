import { BoundedCache } from "@ace/provider-kit/bounded-cache";
export interface CachedRecord<T> {
  value: T;
  json: string;
  bytes: number;
}
/** One budget for a snapshot, including every agent's native-run dictionary. */
export class RecordCache {
  private readonly entries = new BoundedCache<string, CachedRecord<unknown>>(512, 1_048_576);
  get<T>(section: string, key: string): CachedRecord<T> | undefined {
    // Only Records<T> writes this section, after its boundary decoder. No external cast.
    return this.entries.get(JSON.stringify([section, key])) as CachedRecord<T> | undefined;
  }
  set<T>(section: string, key: string, entry: CachedRecord<T>) {
    this.entries.set(JSON.stringify([section, key]), entry, entry.bytes);
  }
  delete(section: string, key: string) {
    this.entries.delete(JSON.stringify([section, key]));
  }
}
export interface RecordTransaction {
  readonly tracking: boolean;
  touch(section: { flush(): void }): void;
}
