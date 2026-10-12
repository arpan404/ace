import type { IconRef, ToolIcon } from "@ace/protocol";
import { iconKey, type IconCache } from "./icon-cache.ts";

/*
 * Resolves the icons browser and computer-use steps show (ADR 0002: public favicon fetches and
 * local app icons only). Each site or app is looked up once at a time, at most `limit` at once;
 * a known icon answers from the cache's in-memory index at once, and one past its lifetime is
 * answered as it was while it is looked up again.
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
  /** Lookups allowed to wait; past this a request is told to ask again later. */
  backlog?: number;
}

export class IconService {
  private readonly options: IconServiceOptions;
  private readonly flying = new Map<string, Promise<IconRef | null | undefined>>();
  private readonly waiting: (() => void)[] = [];
  private active = 0;
  constructor(options: IconServiceOptions) {
    this.options = options;
  }

  /** The icon's ref if it was resolved before; never looks anything up or touches the disk. */
  cached(icon: ToolIcon): IconRef | undefined {
    return this.options.cache.lookup(icon, this.options.now())?.ref ?? undefined;
  }

  read(ref: IconRef): Promise<Buffer | undefined> {
    return this.options.cache.read(ref);
  }

  /** The icon's ref; null when it has none, undefined when the lookup may succeed later. */
  async resolve(icon: ToolIcon): Promise<IconRef | null | undefined> {
    const known = this.options.cache.lookup(icon, this.options.now());
    if (known?.fresh) return known.ref;
    const lookup = this.lookup(icon);
    // A stale icon still stands for its site while the new one is fetched.
    return known ? known.ref : lookup;
  }

  private lookup(icon: ToolIcon): Promise<IconRef | null | undefined> {
    const key = iconKey(icon);
    const existing = this.flying.get(key);
    if (existing) return existing;
    const pending = this.run(icon)
      .catch(() => undefined)
      .finally(() => this.flying.delete(key));
    this.flying.set(key, pending);
    return pending;
  }

  /** A slot to look up in; a finished lookup hands its slot straight to the next one waiting. */
  private async acquire(): Promise<boolean> {
    if (this.active < (this.options.limit ?? 8)) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= (this.options.backlog ?? 64)) return false;
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return true;
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private async run(icon: ToolIcon): Promise<IconRef | null | undefined> {
    if (!(await this.acquire())) return undefined;
    try {
      const source = icon.kind === "site" ? this.options.site : this.options.app;
      const bytes = await source(icon).catch(() => undefined);
      const png = bytes ? await this.options.normalize(bytes, icon) : bytes;
      // Only a definite answer is remembered; a passing failure is asked again next time.
      if (png === undefined) return undefined;
      return await this.options.cache.store(icon, png, this.options.now());
    } finally {
      this.release();
    }
  }
}
