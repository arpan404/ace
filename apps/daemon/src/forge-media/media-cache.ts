import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/*
 * Media fetched for forge text, on disk (ADR 0096): each file once under its SHA-256
 * (`<root>/<sha256>`) and one index of what each media key resolved to (`<root>/index.json`).
 * The index lives in memory, so a lookup never touches the disk; files are bounded by count and
 * bytes, least recently used first. An attachment's bytes never change, so its entry stays
 * fresh; anything else is fetched again after a week, the old bytes standing until then. Kept
 * apart from everything else ace stores; clients read files by hash through
 * `forge.media.download`.
 */

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Entry = z.object({
  sha256,
  mimeType: z.string().min(1).max(64),
  kind: z.enum(["image", "video"]),
  bytes: z.number().int().positive(),
});
export type CachedMedia = z.infer<typeof Entry>;
const Index = z.object({
  keys: z.array(z.tuple([z.string().max(4096), Entry, z.number().int().nonnegative()])),
});

/** Where the daemon keeps forge media under its data directory. */
export function forgeMediaRoot(dataDir: string): string {
  return join(dataDir, "forge-media");
}

export interface ForgeMediaCacheLimits {
  maxFiles: number;
  maxBytes: number;
  /** How long a non-attachment entry stands before it is fetched again. */
  ttlMs: number;
}
const defaults: ForgeMediaCacheLimits = {
  maxFiles: 2048,
  maxBytes: 512 * 1024 * 1024,
  ttlMs: 7 * 24 * 3600_000,
};

export class ForgeMediaCache {
  readonly root: string;
  private readonly limits: ForgeMediaCacheLimits;
  private readonly keys = new Map<string, { media: CachedMedia; at: number }>();
  /** Files by hash, least recently used first, with their sizes. */
  private readonly files = new Map<string, number>();
  private bytes = 0;
  private writing: Promise<void> = Promise.resolve();
  constructor(root: string, limits: Partial<ForgeMediaCacheLimits> = {}) {
    this.root = root;
    this.limits = { ...defaults, ...limits };
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Startup reads the folder and the index once, bounded by the limits above.
    for (const name of readdirSync(root)) {
      if (name.endsWith(".tmp")) {
        // A fetch a crash cut short: never cached media.
        try {
          unlinkSync(join(root, name));
        } catch {
          /* Already gone. */
        }
        continue;
      }
      if (!sha256.safeParse(name).success) continue;
      try {
        const size = statSync(join(root, name)).size;
        this.files.set(name, size);
        this.bytes += size;
      } catch {
        /* Gone since it was listed. */
      }
    }
    try {
      const index = Index.parse(JSON.parse(readFileSync(join(root, "index.json"), "utf8")));
      for (const [key, media, at] of index.keys)
        if (this.files.get(media.sha256) === media.bytes) this.keys.set(key, { media, at });
    } catch {
      /* No index yet, or an unreadable one: media is fetched again. */
    }
  }

  /** What `key` resolved to, and whether it is still fresh; undefined when unknown. */
  lookup(key: string, now: number): { media: CachedMedia; fresh: boolean } | undefined {
    const entry = this.keys.get(key);
    if (!entry || !this.files.has(entry.media.sha256)) return undefined;
    this.touch(entry.media.sha256);
    const fresh = key.startsWith("asset:") || now - entry.at < this.limits.ttlMs;
    return { media: entry.media, fresh };
  }

  /** A new temporary file in the cache's folder, for a fetch to write into. */
  temporary(): string {
    return join(this.root, `${randomUUID()}.tmp`);
  }

  /** Take a fetched file as `key`'s media; the temporary file is moved or removed. */
  async adopt(key: string, temporary: string, media: CachedMedia, now: number): Promise<void> {
    if (this.files.has(media.sha256)) await unlink(temporary).catch(() => {});
    else {
      await rename(temporary, join(this.root, media.sha256));
      this.files.set(media.sha256, media.bytes);
      this.bytes += media.bytes;
    }
    this.keys.delete(key);
    this.keys.set(key, { media, at: now });
    this.touch(media.sha256);
    await this.evict(media.sha256);
    this.persist();
  }

  get size(): { files: number; bytes: number } {
    return { files: this.files.size, bytes: this.bytes };
  }

  private touch(hash: string): void {
    const size = this.files.get(hash);
    if (size === undefined) return;
    this.files.delete(hash);
    this.files.set(hash, size);
  }

  /** Oldest files go until the rest fit, never the one just stored; their keys go with them. */
  private async evict(keep: string): Promise<void> {
    const gone = new Set<string>();
    for (const [hash, size] of this.files) {
      if (this.files.size <= this.limits.maxFiles && this.bytes <= this.limits.maxBytes) break;
      if (hash === keep) continue;
      this.files.delete(hash);
      this.bytes -= size;
      gone.add(hash);
    }
    if (!gone.size) return;
    for (const [key, entry] of this.keys) if (gone.has(entry.media.sha256)) this.keys.delete(key);
    await Promise.all([...gone].map((hash) => unlink(join(this.root, hash)).catch(() => {})));
  }

  /** Writes the index after the ones before it, never two at once. */
  private persist(): void {
    const keys = [...this.keys].map(([key, entry]) => [key, entry.media, entry.at]);
    const path = join(this.root, "index.json");
    this.writing = this.writing
      .then(async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ keys }));
        await rename(temporary, path);
      })
      .catch(() => {});
  }

  /** Index writes still on their way (for shutdown and tests). */
  flushed(): Promise<void> {
    return this.writing;
  }
}
