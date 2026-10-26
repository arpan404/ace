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
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type CachedMedia = z.infer<typeof Entry>;
const Index = z.object({
  keys: z.array(z.tuple([z.string().max(4096), Entry, z.number().int().nonnegative()])),
  /** Files least recently used first, so eviction keeps its order across restarts. */
  order: z.array(sha256).optional(),
});
/** Runs `run` after `ms`; returns a cancel. Injected so tests control when the index is written. */
export type Schedule = (ms: number, run: () => void) => () => void;
const systemSchedule: Schedule = (ms, run) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
/** How long index writes wait to gather the stores that follow. */
const persistDelayMs = 1000;

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
  /** A gathered index write waiting its turn. */
  private pending: (() => void) | undefined;
  private readonly schedule: Schedule;
  /** Files being moved into place: counted once, however many stores race for them. */
  private readonly arriving = new Map<string, Promise<void>>();
  constructor(
    root: string,
    limits: Partial<ForgeMediaCacheLimits> = {},
    schedule: Schedule = systemSchedule,
  ) {
    this.root = root;
    this.schedule = schedule;
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
      // Most recently used last, as it was when the index was written.
      for (const hash of index.order ?? []) this.touch(hash);
    } catch {
      /* No index yet, or an unreadable one: media is fetched again. */
    }
  }

  /** What `key` resolved to, and whether it is still fresh; undefined when unknown. */
  lookup(key: string, now: number): { media: CachedMedia; fresh: boolean } | undefined {
    const entry = this.keys.get(key);
    if (!entry || !this.files.has(entry.media.sha256)) return undefined;
    this.touch(entry.media.sha256);
    const fresh = key.includes(" asset:") || now - entry.at < this.limits.ttlMs;
    return { media: entry.media, fresh };
  }

  /** A new temporary file in the cache's folder, for a fetch to write into. */
  temporary(): string {
    return join(this.root, `${randomUUID()}.tmp`);
  }

  /** Take a fetched file as `key`'s media; the temporary file is moved or removed. */
  async adopt(key: string, temporary: string, media: CachedMedia, now: number): Promise<void> {
    const arriving = this.arriving.get(media.sha256);
    if (this.files.has(media.sha256) || arriving) {
      await unlink(temporary).catch(() => {});
      await arriving;
    } else {
      // Reserved before the move, so a second store of the same bytes doesn't count them again.
      const moving = rename(temporary, join(this.root, media.sha256)).then(() => {
        this.files.set(media.sha256, media.bytes);
        this.bytes += media.bytes;
      });
      this.arriving.set(media.sha256, moving);
      try {
        await moving;
      } finally {
        this.arriving.delete(media.sha256);
      }
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

  /** Gathers the stores of the next second into one index write. */
  private persist(): void {
    if (this.pending) return;
    this.pending = this.schedule(persistDelayMs, () => this.write());
  }

  /** Writes the index after the ones before it, never two at once. */
  private write(): void {
    this.pending?.();
    this.pending = undefined;
    const keys = [...this.keys].map(([key, entry]) => [key, entry.media, entry.at]);
    const order = [...this.files.keys()];
    const path = join(this.root, "index.json");
    this.writing = this.writing
      .then(async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ keys, order }));
        await rename(temporary, path);
      })
      .catch(() => {});
  }

  /** Writes a gathered index now and waits for it (for shutdown and tests). */
  flushed(): Promise<void> {
    if (this.pending) this.write();
    return this.writing;
  }
}
