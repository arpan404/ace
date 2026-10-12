import type { IconRef, IconsReadResponse, IconsResolveResponse, ToolIcon } from "@ace/protocol";

/*
 * The site and app icons browser and computer-use rows show, as the daemon resolved them on its
 * own host: asked for in batches (`icons.resolve`), each PNG read once by its content hash
 * (`icons.read`) and kept as a data URL in a bounded cache. Never fetched from the site itself.
 */

export interface ToolIconCacheOptions {
  /** `icons.resolve` for up to 32 icons. */
  resolve(icons: ToolIcon[]): Promise<IconsResolveResponse>;
  /** `icons.read` for one resolved icon. */
  read(ref: IconRef): Promise<IconsReadResponse>;
  /** Icons kept at once; the least recently shown go first. */
  maxIcons?: number;
  /** Run a batch soon (after the rows that ask for icons in one render have asked). */
  defer?(run: () => void): void;
}

/** An icon's image: a data URL, null when there is none, undefined while it loads. */
export type IconImage = string | null | undefined;

export function toolIconKey(icon: ToolIcon): string {
  return icon.kind === "site" ? `site:${icon.origin}` : `app:${icon.identity}`;
}

export class ToolIconCache {
  private readonly images = new Map<string, string | null>();
  private readonly byRef = new Map<IconRef, Promise<string | undefined>>();
  private readonly loading = new Set<string>();
  private readonly queue = new Map<string, ToolIcon>();
  private readonly listeners = new Set<() => void>();
  private readonly options: ToolIconCacheOptions;
  private scheduled = false;
  constructor(options: ToolIconCacheOptions) {
    this.options = options;
  }

  image(icon: ToolIcon): IconImage {
    const id = toolIconKey(icon);
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

  /** Ask for the icon unless it is known or on its way. `ref` skips resolving when known. */
  load(icon: ToolIcon, ref?: IconRef): void {
    const id = toolIconKey(icon);
    if (this.images.has(id) || this.loading.has(id)) return;
    this.loading.add(id);
    if (ref) {
      void this.settle(id, this.read(ref));
      return;
    }
    this.queue.set(id, icon);
    if (this.scheduled) return;
    this.scheduled = true;
    (this.options.defer ?? queueMicrotask)(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    while (this.queue.size) {
      const batch = [...this.queue].slice(0, 32);
      for (const [id] of batch) this.queue.delete(id);
      let refs: readonly (IconRef | null)[] = [];
      try {
        refs = (await this.options.resolve(batch.map(([, icon]) => icon))).refs;
      } catch {
        // Unanswered: asked again the next time a row shows it.
        for (const [id] of batch) this.loading.delete(id);
        continue;
      }
      batch.forEach(([id], index) => {
        const ref = refs[index];
        void this.settle(id, ref ? this.read(ref) : Promise.resolve(null));
      });
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
    this.loading.delete(id);
    // A read that failed now is tried again the next time a row shows the icon.
    if (value === undefined) return;
    this.images.set(id, value);
    const max = this.options.maxIcons ?? 256;
    for (const oldest of this.images.keys()) {
      if (this.images.size <= max) break;
      this.images.delete(oldest);
    }
    if (this.byRef.size > max)
      for (const ref of this.byRef.keys()) {
        if (this.byRef.size <= max) break;
        this.byRef.delete(ref);
      }
    for (const listener of this.listeners) listener();
  }
}
