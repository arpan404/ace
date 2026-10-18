import type { MirrorSidebar, MirrorThread } from "./mirror.ts";

/** Released mirrors a tab keeps, together, while they weigh at most this (ADR 0056). */
export const mirrorCacheBytes = 16 * 1024 * 1024;
/** And at most this many. */
export const mirrorCacheEntries = 32;

/**
 * A tab's released mirrors, least recently used first, so a view opened again paints on its
 * first render. Leased mirrors are never here: they are pinned until released. A cached
 * mirror follows nothing, so it is marked syncing and unconfirmed until the worker's copy
 * replaces it.
 */
export class MirrorCache {
  private entries = new Map<string, { mirror: MirrorThread | MirrorSidebar; bytes: number }>();
  private bytes = 0;
  /** A cached mirror, now the most recently used, still cached. */
  get(key: string): MirrorThread | MirrorSidebar | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.mirror;
  }
  /** A cached mirror, no longer cached (a lease holds it again). */
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
    if (bytes > mirrorCacheBytes) return;
    // Nothing follows it now: what it shows is behind and no longer confirmed.
    mirror.apply([
      { k: "sync", v: true },
      { k: "unconfirmed", v: true },
    ]);
    this.entries.set(key, { mirror, bytes });
    this.bytes += bytes;
    while (this.bytes > mirrorCacheBytes || this.entries.size > mirrorCacheEntries) {
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
