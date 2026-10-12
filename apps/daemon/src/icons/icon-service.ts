import type { IconRef, ToolIcon } from "@ace/protocol";
import { iconKey, type IconCache } from "./icon-cache.ts";

/*
 * Resolves the icons browser and computer-use steps show (ADR 0002: public favicon fetches and
 * local app icons only). Each site or app is looked up once at a time, at most `limit` at once;
 * a known icon answers from the disk cache at once, and one past its lifetime is answered as it
 * was while it is looked up again.
 */

/** Raw icon bytes: null when there is none, undefined when the lookup may succeed later. */
type Source = (icon: ToolIcon) => Promise<Buffer | null | undefined>;

export interface IconServiceOptions {
  cache: IconCache;
  site: Source;
  app: Source;
  /** Bytes from a source as a PNG of at most 64px, with the same null/undefined meaning. */
  normalize(bytes: Buffer, icon: ToolIcon): Promise<Buffer | null | undefined>;
  now(): number;
  /** Lookups in flight at once; more wait their turn. */
  limit?: number;
  /** Lookups allowed to wait; past this a request is answered with no icon for now. */
  backlog?: number;
}

export class IconService {
  private readonly options: IconServiceOptions;
  private readonly flying = new Map<string, Promise<string | null>>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  constructor(options: IconServiceOptions) {
    this.options = options;
  }

  /** The icon's ref if it was resolved before; never looks anything up. */
  cached(icon: ToolIcon): IconRef | undefined {
    return this.options.cache.lookup(icon, this.options.now())?.ref ?? undefined;
  }

  read(ref: IconRef): Buffer | undefined {
    return this.options.cache.read(ref);
  }

  async resolve(icon: ToolIcon): Promise<IconRef | null> {
    const known = this.options.cache.lookup(icon, this.options.now());
    if (known?.fresh) return known.ref;
    const lookup = this.lookup(icon);
    // A stale icon still stands for its site while the new one is fetched.
    return known ? known.ref : lookup;
  }

  private lookup(icon: ToolIcon): Promise<string | null> {
    const key = iconKey(icon);
    const existing = this.flying.get(key);
    if (existing) return existing;
    const pending = this.run(icon)
      .catch(() => null)
      .finally(() => this.flying.delete(key));
    this.flying.set(key, pending);
    return pending;
  }

  private async run(icon: ToolIcon): Promise<string | null> {
    if (this.active >= (this.options.limit ?? 8)) {
      if (this.waiting.length >= (this.options.backlog ?? 64)) return null;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      const source = icon.kind === "site" ? this.options.site : this.options.app;
      const bytes = await source(icon).catch(() => undefined);
      const png = bytes ? await this.options.normalize(bytes, icon) : bytes;
      // Only a definite answer is remembered; a passing failure is asked again next time.
      if (png === undefined) return null;
      return this.options.cache.store(icon, png, this.options.now());
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
