import type { CancelTimer } from "./runtime.ts";
import { type FSWatcher } from "node:fs";
import { sep, relative, dirname, basename, isAbsolute } from "node:path";
import type { SafeRoot } from "./safety.ts";
import { internal, validRelativePath } from "./safety.ts";
import type { GitIgnore } from "./ignore.ts";
import { changedSnapshot, fullSnapshot } from "./watch-snapshot.ts";
import { VisibleTree } from "./visible-tree.ts";
import { type WatchOptions, type WorkspaceWatcher } from "./types.ts";

export async function watch(
  safe: SafeRoot,
  ignore: GitIgnore,
  options: WatchOptions,
  forcePolling: boolean,
): Promise<WorkspaceWatcher> {
  let disposed = false;
  const lifetime = new AbortController();
  let native: FSWatcher | undefined;
  const metadataWatchers: FSWatcher[] = [];
  function closeMetadata() {
    for (const watcher of metadataWatchers.splice(0)) watcher.close();
  }
  let timer: CancelTimer | undefined;
  let interval: CancelTimer | undefined;
  let mode: "native" | "polling" = "native";
  let previous = new VisibleTree([]);
  let full = false;
  let dirty = new Set<string>();
  let tail: Promise<void> | undefined;
  let requested = false;
  let initializing = true;
  const warning = options.onWarning ?? ((message: string) => console.warn(message));
  async function scan(): Promise<void> {
    const changed = dirty;
    dirty = new Set();
    const complete = full || mode === "polling";
    full = false;
    try {
      const plan = complete
        ? { updates: await fullSnapshot(safe, ignore, lifetime.signal), removed: new Set<string>() }
        : await changedSnapshot(safe, ignore, previous, changed, lifetime.signal);
      if (disposed) return;
      if (complete) {
        for (const before of previous.values())
          if (!plan.updates.has(before.path)) plan.removed.add(before.path);
      }
      const changes = previous.apply(plan.updates, plan.removed, changed);
      if (changes.length) options.onChange(changes);
    } catch (error) {
      if (disposed) return;
      for (const path of changed) dirty.add(path);
      full ||= complete;
      warning(`Workspace watch reconciliation failed: ${String(error)}`);
    }
  }
  function reconcile(): Promise<void> {
    if (disposed) return tail ?? Promise.resolve();
    requested = true;
    // One scan and at most one requested follow-up, regardless of event volume.
    tail ??= (async () => {
      do {
        requested = false;
        if (disposed) break;
        await scan();
      } while (requested);
    })().finally(() => {
      tail = undefined;
    });
    return tail;
  }
  function schedule(): void {
    if (disposed || initializing || timer) return;
    timer = safe.runtime.clock.after(() => {
      timer = undefined;
      return reconcile();
    }, 100);
  }
  function polling(reason: string): void {
    if (disposed || mode === "polling") return;
    mode = "polling";
    native?.close();
    closeMetadata();
    native = undefined;
    warning(
      `Workspace recursive watch unavailable; falling back to polling every 100 ms: ${reason}`,
    );
    interval = safe.runtime.clock.every(() => {
      if (!tail && !initializing && !disposed) void reconcile();
    }, 100);
  }
  try {
    const root = await safe.resolve("");
    if (forcePolling) polling("polling explicitly requested");
    else {
      try {
        native = safe.runtime.watch(root, { recursive: true }, (_event, filename) => {
          if (filename !== null) {
            const path = filename.toString().split(sep).join("/");
            if (!validRelativePath(path)) return;
            if (path === ".git/info/exclude" || path === ".git/index" || path === ".git/index.lock")
              full = true;
            else if (internal(path)) return;
            if (!path || path.split("/").at(-1) === ".gitignore") full = true;
            if (dirty.size < 100_000) dirty.add(path);
            else full = true;
          } else full = true;
          schedule();
        });
        native.on("error", (error) => polling(error.message));
        const folders = new Map<string, Set<string>>();
        for (const path of await ignore.metadataPaths(lifetime.signal)) {
          const rel = relative(root, path);
          if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) continue;
          const dir = dirname(path);
          const names = folders.get(dir) ?? new Set<string>();
          names.add(basename(path));
          names.add(basename(path) + ".lock");
          folders.set(dir, names);
        }
        for (const [dir, names] of folders) {
          if (!native) break;
          const subscription = safe.runtime.watch(dir, { recursive: false }, (_event, filename) => {
            if (filename === null || names.has(filename)) {
              full = true;
              schedule();
            }
          });
          subscription.on("error", (error) => polling(error.message));
          metadataWatchers.push(subscription);
        }
      } catch (error) {
        polling(String(error));
      }
    }
    // Subscribe first, then scan, retaining notifications that race initialization.
    previous = new VisibleTree((await fullSnapshot(safe, ignore, lifetime.signal)).values());
    initializing = false;
    if (dirty.size || full) schedule();
  } catch (error) {
    disposed = true;
    native?.close();
    closeMetadata();
    interval?.();
    timer?.();
    throw error;
  }
  return {
    get mode() {
      return mode;
    },
    async flush() {
      timer?.();
      timer = undefined;
      full = true;
      await reconcile();
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      native?.close();
      closeMetadata();
      interval?.();
      timer?.();
      await tail;
      dirty.clear();
      previous = new VisibleTree([]);
    },
  };
}
