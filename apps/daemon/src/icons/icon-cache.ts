import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IconRef, type ToolIcon } from "@ace/protocol";

/*
 * Resolved icons on disk: each PNG once under its SHA-256 (`<root>/<ref>.png`), and for each site
 * or app what it resolved to (`<root>/keys/<hash of key>.json`), misses included so a site with
 * no favicon is not asked again on every row. Kept apart from everything else ace stores and
 * never served to other origins.
 */

const Entry = z.object({ ref: IconRef.nullable(), at: z.number().int().nonnegative() });
type Entry = z.infer<typeof Entry>;

/** How long a resolution stands before it is looked up again. */
const ttl = {
  site: 7 * 24 * 3600_000,
  app: 30 * 24 * 3600_000,
  miss: 24 * 3600_000,
};

export function iconKey(icon: ToolIcon): string {
  return icon.kind === "site" ? `site:${icon.origin}` : `app:${icon.identity}`;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export class IconCache {
  private readonly root: string;
  private readonly keys: string;
  constructor(root: string) {
    this.root = root;
    this.keys = join(root, "keys");
    mkdirSync(this.keys, { recursive: true });
  }

  private entry(icon: ToolIcon): Entry | undefined {
    try {
      const path = join(this.keys, `${sha256(iconKey(icon))}.json`);
      return Entry.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  /**
   * What the icon resolved to: a ref, null for a remembered miss, undefined when unknown. `fresh`
   * says whether it is still within its lifetime.
   */
  lookup(icon: ToolIcon, now: number): { ref: string | null; fresh: boolean } | undefined {
    const entry = this.entry(icon);
    if (!entry || (entry.ref && !existsSync(join(this.root, `${entry.ref}.png`)))) return undefined;
    const life = entry.ref ? ttl[icon.kind] : ttl.miss;
    return { ref: entry.ref, fresh: now - entry.at < life };
  }

  /** Remember what the icon resolved to; returns the PNG's ref. */
  store(icon: ToolIcon, png: Buffer | null, now: number): string | null {
    const ref = png ? sha256(png) : null;
    if (png && ref) write(join(this.root, `${ref}.png`), png);
    write(
      join(this.keys, `${sha256(iconKey(icon))}.json`),
      JSON.stringify({ ref, at: now } satisfies Entry),
    );
    return ref;
  }

  read(ref: string): Buffer | undefined {
    if (!IconRef.safeParse(ref).success) return undefined;
    try {
      return readFileSync(join(this.root, `${ref}.png`));
    } catch {
      return undefined;
    }
  }
}

/** Write through a temporary file, so a reader never sees half an icon. */
function write(path: string, data: string | Buffer): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}
