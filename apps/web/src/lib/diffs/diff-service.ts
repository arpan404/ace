import { frameBatch, immediate, type NotifyBatch } from "@ace/client-react";
import type { FileChange } from "@ace/protocol";
import {
  contentHash,
  diffFile,
  fileDiffKey,
  LruCache,
  type FileChanges,
  type FileDiff,
} from "@ace/ui-core";
import { offThread } from "@/lib/off-thread.ts";

/*
 * File diffs by content key, computed at most once per content however often the Changes tab
 * renders. A diff someone is looking at is held for as long as they look (so a working set larger
 * than the cache never evicts what is on screen and diffs it again); every other diff lives in a
 * bounded LRU, then in the diff worker's IndexedDB copy.
 */

export interface Keyed {
  file: FileChanges;
  key: string;
}

export interface DiffService {
  /**
   * Hold the diffs of `files` while watched, computing those not ready yet. `ready` runs when one
   * of them becomes ready, at most once per notification batch (an animation frame in the app).
   */
  watch(files: readonly Keyed[], ready: () => void): () => void;
  /** The diff if it is ready; without a worker it is computed here, in place. */
  peek(key: string, file: FileChanges): FileDiff | undefined;
}

interface Held {
  refs: number;
  diff: FileDiff | undefined;
  listeners: Set<() => void>;
}

export function createDiffService(options: {
  compute(key: string, file: FileChanges): Promise<FileDiff>;
  /** Set when there is no worker: diffs are then computed synchronously on first read. */
  inPlace?: ((file: FileChanges) => FileDiff) | undefined;
  batch: NotifyBatch;
  /** Bounds of the cache of diffs nobody is looking at. */
  maxEntries: number;
  maxRows: number;
}): DiffService {
  const memory = new LruCache<string, FileDiff>({
    maxEntries: options.maxEntries,
    maxWeight: options.maxRows,
    weigh: (diff) => diff.rows.length + 1,
  });
  const held = new Map<string, Held>();
  const running = new Set<string>();
  const settle = (key: string, diff: FileDiff) => {
    memory.set(key, diff);
    const entry = held.get(key);
    if (!entry || entry.diff === diff) return;
    entry.diff = diff;
    for (const listener of entry.listeners) options.batch.schedule(listener);
  };
  const start = (key: string, file: FileChanges) => {
    if (running.has(key)) return;
    running.add(key);
    options.compute(key, file).then(
      (diff) => {
        running.delete(key);
        settle(key, diff);
      },
      () => running.delete(key),
    );
  };
  const peek = (key: string, file: FileChanges): FileDiff | undefined => {
    const entry = held.get(key);
    const known = entry?.diff ?? memory.get(key);
    if (known || !options.inPlace) return known;
    const diff = options.inPlace(file);
    memory.set(key, diff);
    if (entry) entry.diff = diff;
    return diff;
  };
  return {
    peek,
    watch(files, ready) {
      const entries = files.map(({ key, file }) => {
        let entry = held.get(key);
        if (!entry) {
          entry = { refs: 0, diff: memory.get(key), listeners: new Set() };
          held.set(key, entry);
        }
        entry.refs++;
        entry.listeners.add(ready);
        if (!entry.diff) start(key, file);
        return [key, entry] as const;
      });
      return () => {
        options.batch.cancel(ready);
        for (const [key, entry] of entries) {
          entry.listeners.delete(ready);
          if (--entry.refs > 0) continue;
          held.delete(key);
          // Back to the bounded cache; one heavier than the whole cache is dropped here.
          if (entry.diff) memory.set(key, entry.diff);
        }
      };
    },
  };
}

/** What a view of several files reads: their diffs in order, a new array only when one lands. */
export interface DiffView {
  subscribe(changed: () => void): () => void;
  read(): readonly (FileDiff | undefined)[];
}

/** A `useSyncExternalStore` source over `files`' diffs. */
export function diffView(service: DiffService, files: readonly Keyed[]): DiffView {
  const readAll = () => files.map(({ key, file }) => service.peek(key, file));
  let current = readAll();
  let stale = false;
  return {
    subscribe(changed) {
      const stop = service.watch(files, () => {
        stale = true;
        changed();
      });
      // A diff may have landed between the first read and this subscription.
      stale = true;
      return stop;
    },
    read() {
      if (!stale) return current;
      stale = false;
      const next = readAll();
      if (next.some((diff, index) => diff !== current[index])) current = next;
      return current;
    },
  };
}

/** Change objects are immutable store values, so their part of the key is computed once. */
const changeKeys = new WeakMap<FileChange, string>();
export function diffKey(file: FileChanges): string {
  const parts = file.changes.map((change) => {
    let key = changeKeys.get(change);
    if (!key) {
      key = fileDiffKey({ path: "", changes: [change] }, contentHash);
      changeKeys.set(change, key);
    }
    return key;
  });
  return contentHash(`${file.path}|${parts.join("|")}`);
}

const worker = offThread<{ key: string; file: FileChanges }, FileDiff>({
  spawn: () =>
    new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module", name: "ace-diff" }),
  local: ({ file }) => diffFile(file),
  // Built from the same ui-core code in a same-origin worker; not decoded twice.
  decode: (output) => output as FileDiff,
});

/** The app's diffs: the diff worker, ~200k rows cached beyond what is on screen. */
export const diffService = createDiffService({
  compute: (key, file) => worker.run({ key, file }),
  inPlace: worker.parallel ? undefined : diffFile,
  // Diffs that finish within one frame reach React together; a hidden page renders none.
  batch:
    typeof requestAnimationFrame === "function"
      ? frameBatch((flush) => requestAnimationFrame(flush))
      : immediate,
  maxEntries: 600,
  maxRows: 200_000,
});
