import type { IconRef, IconsReadResponse, IconsResolveResponse, ThreadId } from "@ace/protocol";

/*
 * The site and app icons browser and computer-use rows show, as the daemon resolved them on its
 * own host for the thread's recorded steps: asked for in batches by step (`icons.resolve`), each
 * PNG read once by its content hash (`icons.read`) and kept as a data URL in a bounded cache.
 * Never fetched from the site itself. A lookup that failed in a way that may pass is asked again
 * after a while, never remembered as "no icon".
 */

export interface ToolIconCacheOptions {
  /** `icons.resolve` for up to 32 of a thread's steps. */
  resolve(threadId: ThreadId, itemIds: string[]): Promise<IconsResolveResponse>;
  /** `icons.read` for one resolved icon. */
  read(ref: IconRef): Promise<IconsReadResponse>;
  /** Icons kept at once; the least recently shown go first. */
  maxIcons?: number;
  /** How long to wait before asking again about an icon that may come later. */
  retryMs?: number;
  now?(): number;
  /** Run a batch soon (after the rows that ask for icons in one render have asked). */
  defer?(run: () => void): void;
}

/** An icon's image: a data URL, null when there is none, undefined while it loads. */
export type IconImage = string | null | undefined;

const stepKey = (threadId: string, itemId: string) => `${threadId}\u0000${itemId}`;

export class ToolIconCache {
  private readonly images = new Map<string, string | null>();
  private readonly byRef = new Map<IconRef, Promise<string | undefined>>();
  private readonly loading = new Set<string>();
  /** Steps whose icon may come later, and when to ask again. */
  private readonly retryAt = new Map<string, number>();
  private readonly queue = new Map<ThreadId, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private readonly options: ToolIconCacheOptions;
  private scheduled = false;
  constructor(options: ToolIconCacheOptions) {
    this.options = options;
  }

  image(threadId: string, itemId: string): IconImage {
    const id = stepKey(threadId, itemId);
    const image = this.images.get(id);
    if (image === undefined) return undefined;
    this.images.delete(id);
    this.images.set(id, image);
    return image;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ask for a step's icon unless it is known, on its way or due later. `ref` skips resolving. */
  load(threadId: ThreadId, itemId: string, ref?: IconRef): void {
    const id = stepKey(threadId, itemId);
    if (this.images.has(id) || this.loading.has(id)) return;
    if ((this.retryAt.get(id) ?? 0) > this.now()) return;
    this.loading.add(id);
    if (ref) {
      void this.settle(id, this.read(ref));
      return;
    }
    let steps = this.queue.get(threadId);
    if (!steps) this.queue.set(threadId, (steps = new Set()));
    steps.add(itemId);
    if (this.scheduled) return;
    this.scheduled = true;
    (this.options.defer ?? queueMicrotask)(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private later(id: string): void {
    this.loading.delete(id);
    this.retryAt.set(id, this.now() + (this.options.retryMs ?? 30_000));
    const max = (this.options.maxIcons ?? 256) * 4;
    for (const old of this.retryAt.keys()) {
      if (this.retryAt.size <= max) break;
      this.retryAt.delete(old);
    }
  }

  private async flush(): Promise<void> {
    for (const [threadId, steps] of this.queue) {
      this.queue.delete(threadId);
      const ids = [...steps];
      for (let start = 0; start < ids.length; start += 32) {
        const batch = ids.slice(start, start + 32);
        let icons: IconsResolveResponse["icons"];
        try {
          icons = (await this.options.resolve(threadId, batch)).icons;
        } catch {
          for (const itemId of batch) this.later(stepKey(threadId, itemId));
          continue;
        }
        batch.forEach((itemId, index) => {
          const id = stepKey(threadId, itemId);
          const result = icons[index];
          if (result?.state === "found" && result.ref) void this.settle(id, this.read(result.ref));
          else if (result?.state === "none") void this.settle(id, Promise.resolve(null));
          else this.later(id);
        });
      }
    }
  }

  /** The PNG as a data URL; undefined when it could not be read now. */
  private read(ref: IconRef): Promise<string | undefined> {
    let pending = this.byRef.get(ref);
    if (!pending) {
      pending = this.options
        .read(ref)
        .then((reply) => `data:${reply.mimeType};base64,${reply.data}`)
        .catch(() => {
          this.byRef.delete(ref);
          return undefined;
        });
      this.byRef.set(ref, pending);
    }
    return pending;
  }

  private async settle(id: string, image: Promise<string | null | undefined>): Promise<void> {
    const value = await image;
    if (value === undefined) {
      this.later(id);
      return;
    }
    this.loading.delete(id);
    this.retryAt.delete(id);
    this.images.set(id, value);
    const max = this.options.maxIcons ?? 256;
    for (const oldest of this.images.keys()) {
      if (this.images.size <= max) break;
      this.images.delete(oldest);
    }
    for (const ref of this.byRef.keys()) {
      if (this.byRef.size <= max) break;
      this.byRef.delete(ref);
    }
    for (const listener of this.listeners) listener();
  }
}
