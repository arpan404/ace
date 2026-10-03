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
 * File diffs by content key: memory first, then the diff worker (which keeps an IndexedDB
 * copy), computed at most once per content however often the Changes tab renders.
 */

const memory = new LruCache<string, FileDiff>({
  maxEntries: 600,
  // Rows are the cost of a diff; ~200k rows of memory across every open file.
  maxWeight: 200_000,
  weigh: (diff) => diff.rows.length + 1,
});
const running = new Map<string, Promise<FileDiff>>();
const worker = offThread<{ key: string; file: FileChanges }, FileDiff>({
  spawn: () =>
    new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module", name: "ace-diff" }),
  local: ({ file }) => diffFile(file),
  // Built from the same ui-core code in a same-origin worker; not decoded twice.
  decode: (output) => output as FileDiff,
});

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

/** What is ready now. A new object whenever a diff finishes, for useSyncExternalStore. */
export interface ReadyDiffs {
  /** The diff if it is ready; without a worker it is computed here, in place. */
  get(key: string, file: FileChanges): FileDiff | undefined;
}
function peek(key: string, file: FileChanges): FileDiff | undefined {
  const known = memory.get(key);
  if (known || worker.parallel) return known;
  const diff = diffFile(file);
  memory.set(key, diff);
  return diff;
}
let ready: ReadyDiffs = { get: peek };
const listeners = new Set<() => void>();
const changed = () => {
  ready = { get: peek };
  for (const listener of listeners) listener();
};

export const diffService = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  ready: (): ReadyDiffs => ready,
  load(key: string, file: FileChanges): Promise<FileDiff> {
    const known = memory.get(key);
    if (known) return Promise.resolve(known);
    let pending = running.get(key);
    if (!pending) {
      pending = worker.run({ key, file }).then(
        (diff) => {
          running.delete(key);
          memory.set(key, diff);
          changed();
          return diff;
        },
        (error: unknown) => {
          running.delete(key);
          throw error;
        },
      );
      running.set(key, pending);
    }
    return pending;
  },
};
