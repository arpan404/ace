import type { Intent } from "@ace/client";

interface Record {
  value: Intent | undefined;
  watchers: number;
}
/** Pure weighted cache. Watched intents are pinned; unwatched full commands are bounded. */
export class IntentCache {
  private records = new Map<string, Record>();
  private sizes = new Map<string, number>();
  private count = 0;
  private bytes = 0;
  private limit: number;
  private byteLimit: number;
  constructor(limit: number, byteLimit: number) {
    this.limit = limit;
    this.byteLimit = byteLimit;
  }
  get(id: string): Record | undefined {
    return this.records.get(id);
  }
  entries(): MapIterator<[string, Record]> {
    return this.records.entries();
  }
  put(id: string, value: Intent | undefined): void {
    const previous = this.records.get(id);
    if (previous?.watchers === 0) {
      this.count--;
      this.bytes -= this.sizes.get(id) ?? 0;
    }
    const record = previous ?? { value: undefined, watchers: 0 };
    record.value = value;
    const size = value ? new TextEncoder().encode(JSON.stringify(value)).byteLength : 0;
    this.records.set(id, record);
    this.sizes.set(id, size);
    if (record.watchers === 0) {
      this.count++;
      this.bytes += size;
    }
    this.prune();
  }
  watch(id: string): Record {
    let record = this.records.get(id);
    if (record) {
      if (record.watchers === 0) {
        this.count--;
        this.bytes -= this.sizes.get(id) ?? 0;
      }
    } else {
      record = { value: undefined, watchers: 0 };
      this.records.set(id, record);
    }
    record.watchers++;
    return record;
  }
  /** Returns true when the last watcher left, so the shell can release its worker lease. */
  unwatch(id: string): boolean {
    const record = this.records.get(id);
    if (!record || --record.watchers > 0) return false;
    // Watched records have not contributed to the unwatched counters.
    this.records.delete(id);
    this.sizes.delete(id);
    return true;
  }
  forget(id: string): void {
    if (this.records.get(id)?.watchers === 0) {
      this.count--;
      this.bytes -= this.sizes.get(id) ?? 0;
    }
    this.records.delete(id);
    this.sizes.delete(id);
  }
  clear(): void {
    this.records.clear();
    this.sizes.clear();
    this.count = 0;
    this.bytes = 0;
  }
  private prune(): void {
    const fits = () => this.count <= this.limit && this.bytes <= this.byteLimit;
    if (fits()) return;
    for (const [id, record] of this.records) {
      if (record.watchers > 0) continue;
      this.forget(id);
      if (fits()) break;
    }
  }
}
