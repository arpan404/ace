import { CommandCatalog } from "./catalog.ts";
import { CommandFiles, type WatchSource } from "./files.ts";
import type { RecoveryScheduler, RecoveryTimer } from "./recovery-loop.ts";
import type { DiscoveryRoot } from "./roots.ts";

/** How long a folder watch outlives its last subscriber, so reopening the Skills page is free. */
export const skillWatchLingerMs = 10 * 60_000;
const watchLimit = 9;

const lingerTimer: RecoveryTimer = (run, delay) => {
  const handle = setTimeout(run, delay);
  handle.unref();
  return () => clearTimeout(handle);
};

export interface SkillWatchOptions {
  /** The skill folders behind one key: `""` for personal folders, else a project path. */
  roots(key: string): DiscoveryRoot[];
  /** Something on disk changed after the first walk; never called during it. */
  changed(): void;
  watch?: WatchSource | undefined;
  schedule?: RecoveryScheduler | undefined;
  linger?: RecoveryTimer | undefined;
}
interface Held {
  files: CommandFiles;
  users: number;
  /** The first walk is done: from here on every change is heard, so a cached listing holds. */
  ready: boolean;
  expire: (() => void) | undefined;
}

/**
 * Folder watches for the skill library and the listings they keep valid. A listing is cached
 * only while every folder it read is watched and past its first walk; any change, or any
 * change ace makes itself, drops the cache, so a cached answer is never older than the disk.
 */
export class SkillWatches<T> {
  private readonly options: SkillWatchOptions;
  private readonly held = new Map<string, Held>();
  private readonly cache = new Map<string, T>();
  private generation = 0;
  private closed = false;
  constructor(options: SkillWatchOptions) {
    this.options = options;
  }
  /** Watch `key`'s folders until the returned release, plus the linger after it. */
  hold(key: string): () => void {
    if (this.closed) throw new Error("Skill watches closed");
    const held = this.held.get(key) ?? this.open(key);
    held.users++;
    held.expire?.();
    held.expire = undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.users > 0 || this.held.get(key) !== held) return;
      held.expire = (this.options.linger ?? lingerTimer)(
        () => this.drop(key, held),
        skillWatchLingerMs,
      );
    };
  }
  /** The listing behind `keys`, from cache while their watches can vouch for it. */
  async read(keys: readonly string[], load: () => Promise<T>): Promise<T> {
    const id = keys.join("\0");
    if (!this.ready(keys)) return load();
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const generation = this.generation;
    const value = await load();
    // A change while it loaded may not be in it: answer with it, but don't keep it.
    if (generation === this.generation && this.ready(keys)) this.cache.set(id, value);
    return value;
  }
  /** Drop every cached listing: ace changed something, or a source outside the folders did. */
  forget(): void {
    this.generation++;
    this.cache.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.forget();
    const held = [...this.held.values()];
    this.held.clear();
    for (const entry of held) {
      entry.expire?.();
      await entry.files.close();
    }
  }
  private ready(keys: readonly string[]): boolean {
    return keys.every((key) => this.held.get(key)?.ready === true);
  }
  private open(key: string): Held {
    if (this.held.size >= watchLimit) {
      // Make room from a watch nobody is using any more before refusing a new one.
      const idle = [...this.held].find(([, entry]) => entry.users === 0);
      if (!idle) throw new Error("Skill watch limit");
      this.drop(idle[0], idle[1]);
    }
    const files = new CommandFiles(new CommandCatalog(() => 0), this.options.roots(key), {
      ...(this.options.watch ? { watch: this.options.watch } : {}),
      ...(this.options.schedule ? { schedule: this.options.schedule } : {}),
    });
    const held: Held = { files, users: 0, ready: false, expire: undefined };
    this.held.set(key, held);
    // The first walk finds every skill once; its per-folder progress is not a change to anyone.
    files.subscribe(() => {
      if (!held.ready || this.held.get(key) !== held) return;
      this.forget();
      this.options.changed();
    });
    void files
      .start()
      .then(() => {
        if (this.held.get(key) !== held) return;
        held.ready = true;
        // Anything that moved during the walk is caught by one fresh listing.
        this.forget();
        this.options.changed();
      })
      .catch(() => {});
    return held;
  }
  private drop(key: string, held: Held): void {
    if (this.held.get(key) !== held) return;
    this.held.delete(key);
    held.expire?.();
    this.forget();
    void held.files.close();
  }
}
