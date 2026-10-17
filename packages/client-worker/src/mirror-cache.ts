import type { MirrorSidebar, MirrorThread } from "./mirror.ts";

/** Inactive tab mirrors, separate from leased views and the worker's authoritative projection. */
export class MirrorCache {
  private entries = new Map<string, { mirror: MirrorThread | MirrorSidebar; bytes: number }>();
  private bytes = 0;
  get(key: string): MirrorThread | MirrorSidebar | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    // Refresh recency: eviction walks insertion order, so a hot peek must re-insert.
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.mirror;
  }
  take(key: string): MirrorThread | MirrorSidebar | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    this.entries.delete(key);
    this.bytes -= cached.bytes;
    return cached.mirror;
  }
  set(key: string, mirror: MirrorThread | MirrorSidebar): void {
    this.take(key);
    const bytes = mirror.retainedBytes();
    if (bytes > 16 * 1024 * 1024) return;
    mirror.apply([{ k: "sync", v: true }]);
    this.entries.set(key, { mirror, bytes });
    this.bytes += bytes;
    while (this.bytes > 16 * 1024 * 1024 || this.entries.size > 32) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.take(oldest);
    }
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
