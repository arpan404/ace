import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IconRef, type ToolIcon } from "@ace/protocol";

/*
 * Resolved icons on disk: each PNG once under its SHA-256 (`<root>/<ref>.png`) and one index of
 * what each site or app resolved to (`<root>/index.json`), misses included so a site with no
 * favicon is not asked again on every row. The index lives in memory, so looking an icon up never
 * touches the disk; the PNGs are bounded by count and bytes, least recently used first. Kept
 * apart from everything else ace stores and never served to other origins.
 */

const Index = z.object({
  keys: z.array(
    z.tuple([z.string().max(2048), IconRef.nullable(), z.number().int().nonnegative()]),
  ),
});

/** How long a resolution stands before it is looked up again. */
const ttl = {
  site: 7 * 24 * 3600_000,
  app: 30 * 24 * 3600_000,
  miss: 24 * 3600_000,
};

export interface IconCacheLimits {
  maxIcons: number;
  maxBytes: number;
}

export function iconKey(icon: ToolIcon): string {
  return icon.kind === "site" ? `site:${icon.origin}` : `app:${icon.identity}`;
}

export class IconCache {
  private readonly root: string;
  private readonly limits: IconCacheLimits;
  private readonly keys = new Map<string, { ref: string | null; at: number }>();
  /** PNGs by ref, least recently used first, with their sizes. */
  private readonly images = new Map<string, number>();
  private bytes = 0;
  private writing: Promise<void> = Promise.resolve();
  constructor(
    root: string,
    limits: IconCacheLimits = { maxIcons: 512, maxBytes: 16 * 1024 * 1024 },
  ) {
    this.root = root;
    this.limits = limits;
    mkdirSync(root, { recursive: true });
    // Startup reads the index and the folder once; bounded by the limits above.
    for (const name of readdirSync(root)) {
      const ref = name.endsWith(".png") ? name.slice(0, -4) : "";
      if (!IconRef.safeParse(ref).success) continue;
      const size = statSync(join(root, name)).size;
      this.images.set(ref, size);
      this.bytes += size;
    }
    try {
      const index = Index.parse(JSON.parse(readFileSync(join(root, "index.json"), "utf8")));
      for (const [key, ref, at] of index.keys)
        if (ref === null || this.images.has(ref)) this.keys.set(key, { ref, at });
    } catch {
      /* No index yet, or an unreadable one: icons are looked up again. */
    }
  }

  /**
   * What the icon resolved to: a ref, null for a remembered miss, undefined when unknown. `fresh`
   * says whether it is still within its lifetime.
   */
  lookup(icon: ToolIcon, now: number): { ref: string | null; fresh: boolean } | undefined {
    const entry = this.keys.get(iconKey(icon));
    if (!entry || (entry.ref && !this.images.has(entry.ref))) return undefined;
    const life = entry.ref ? ttl[icon.kind] : ttl.miss;
    return { ref: entry.ref, fresh: now - entry.at < life };
  }

  /** Remember what the icon resolved to; returns the PNG's ref. */
  async store(icon: ToolIcon, png: Buffer | null, now: number): Promise<string | null> {
    const ref = png ? createHash("sha256").update(png).digest("hex") : null;
    if (png && ref && !this.images.has(ref)) {
      await write(join(this.root, `${ref}.png`), png);
      this.images.set(ref, png.length);
      this.bytes += png.length;
    }
    const key = iconKey(icon);
    this.keys.delete(key);
    this.keys.set(key, { ref, at: now });
    if (ref) this.touch(ref);
    await this.evict();
    this.persist();
    return ref;
  }

  async read(ref: string): Promise<Buffer | undefined> {
    if (!IconRef.safeParse(ref).success || !this.images.has(ref)) return undefined;
    this.touch(ref);
    try {
      return await readFile(join(this.root, `${ref}.png`));
    } catch {
      return undefined;
    }
  }

  get size(): { icons: number; bytes: number } {
    return { icons: this.images.size, bytes: this.bytes };
  }

  private touch(ref: string): void {
    const size = this.images.get(ref);
    if (size === undefined) return;
    this.images.delete(ref);
    this.images.set(ref, size);
  }

  /** Oldest icons go until the rest fit; what resolved to them is forgotten with them. */
  private async evict(): Promise<void> {
    const gone = new Set<string>();
    for (const [ref, size] of this.images) {
      if (this.images.size <= this.limits.maxIcons && this.bytes <= this.limits.maxBytes) break;
      this.images.delete(ref);
      this.bytes -= size;
      gone.add(ref);
    }
    // Misses are tiny, but still bounded.
    for (const key of this.keys.keys()) {
      if (this.keys.size <= this.limits.maxIcons * 4) break;
      this.keys.delete(key);
    }
    if (!gone.size) return;
    for (const [key, entry] of this.keys)
      if (entry.ref && gone.has(entry.ref)) this.keys.delete(key);
    await Promise.all(
      [...gone].map((ref) => unlink(join(this.root, `${ref}.png`)).catch(() => {})),
    );
  }

  /** Writes the index after the ones before it, never two at once. */
  private persist(): void {
    const keys = [...this.keys].map(([key, entry]) => [key, entry.ref, entry.at]);
    this.writing = this.writing
      .then(() => write(join(this.root, "index.json"), JSON.stringify({ keys })))
      .catch(() => {});
  }

  /** Index writes still on their way (for shutdown and tests). */
  flushed(): Promise<void> {
    return this.writing;
  }
}

/** Write through a temporary file, so a reader never sees half a file. */
async function write(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}
