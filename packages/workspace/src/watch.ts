import type { CancelTimer } from "./runtime.ts";
import { isAbsolute, relative, sep } from "node:path";
import { DirectoryWatches } from "./directory-watches.ts";
import { WatchMetadata } from "./watch-metadata.ts";
import type { SafeRoot } from "./safety.ts";
import { internal, validRelativePath } from "./safety.ts";
import type { GitIgnore } from "./ignore.ts";
import { changedSnapshot, fullSnapshot } from "./watch-snapshot.ts";
import { VisibleTree } from "./visible-tree.ts";
import { type Entry, type WatchOptions, type WorkspaceWatcher } from "./types.ts";

export async function watch(
  safe: SafeRoot,
  ignore: GitIgnore,
  options: WatchOptions,
  forcePolling: boolean,
): Promise<WorkspaceWatcher> {
  let disposed = false;
  const lifetime = new AbortController();
  let native: { close(): void } | undefined;
  let directories: DirectoryWatches | undefined;
  let timer: CancelTimer | undefined;
  let interval: CancelTimer | undefined;
  let pollDelay = 1000;
  let mode: "native" | "polling" = "native";
  let previous = new VisibleTree([]);
  let full = false;
  let metadataDirty = false;
  let dirty = new Set<string>();
  /** Directories rescanned for entries that raced their new watch; never reported as changed. */
  let revisit = new Set<string>();
  let tail: Promise<void> | undefined;
  let requested = false;
  let initializing = true;
  const metadata = new WatchMetadata(
    safe,
    ignore,
    lifetime.signal,
    (kind) => {
      if (disposed) return;
      full ||= kind === "visibility";
      metadataDirty = true;
      schedule();
    },
    polling,
    // Without a recursive watch, Git metadata inside the workspace needs its own.
    (path) => safe.runtime.platform !== "linux" && inside(path),
  );
  function inside(path: string): boolean {
    const local = relative(safe.root, path);
    return local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local);
  }
  const warning = options.onWarning ?? ((message: string) => console.warn(message));
  async function scan(): Promise<void> {
    const changed = dirty;
    dirty = new Set();
    const revisits = revisit;
    revisit = new Set();
    const targets = revisits.size ? new Set([...changed, ...revisits]) : changed;
    let complete = full || mode === "polling";
    const refreshMetadata = metadataDirty;
    metadataDirty = false;
    full = false;
    try {
      // New sources must be subscribed before the inventory reads their rules.
      // Notifications arriving during either step remain queued for the drain.
      if (refreshMetadata && mode === "native") {
        const configurationChanged = await metadata.refresh();
        complete ||= configurationChanged;
      }
      if (disposed) return;
      complete ||= mode === "polling";
      const plan = complete
        ? { updates: await fullSnapshot(safe, ignore, lifetime.signal), removed: new Set<string>() }
        : targets.size
          ? await changedSnapshot(safe, ignore, previous, targets, lifetime.signal)
          : { updates: new Map<string, Entry>(), removed: new Set<string>() };
      if (disposed) return;
      if (complete) {
        for (const before of previous.values())
          if (!plan.updates.has(before.path)) plan.removed.add(before.path);
      }
      const changes = previous.apply(plan.updates, plan.removed, changed);
      follow(plan.updates.values(), plan.removed);
      if (changes.length) options.onChange(changes);
      if (mode === "polling") pollDelay = changes.length ? 1000 : Math.min(30_000, pollDelay * 2);
      else {
        pollDelay = 1000;
        if (!dirty.size && !revisit.size && !full && !metadataDirty) {
          timer?.();
          timer = undefined;
        }
      }
    } catch (error) {
      if (disposed) return;
      for (const path of changed) dirty.add(path);
      for (const path of revisits) revisit.add(path);
      full ||= complete;
      metadataDirty ||= refreshMetadata;
      pollDelay = Math.min(30_000, pollDelay * 2);
      warning(`Workspace watch reconciliation failed: ${String(error)}`);
      if (mode === "native" && !timer)
        timer = safe.runtime.clock.after(() => {
          timer = undefined;
          return reconcile();
        }, pollDelay);
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
  function armPoll(): void {
    if (disposed) return;
    interval = safe.runtime.clock.after(async () => {
      interval = undefined;
      if (!initializing) await reconcile();
      armPoll();
    }, pollDelay);
  }
  /** Watches directories the scan revealed and rescans them for entries that raced the watch. */
  function follow(updates: Iterable<Entry>, removed: Iterable<string>): void {
    if (!directories || mode !== "native") return;
    for (const dir of directories.sync(updates, removed)) {
      if (revisit.size < 100_000) revisit.add(dir);
      else full = true;
    }
    if (revisit.size || full) schedule();
  }
  function notified(filename: string | null): void {
    if (filename !== null) {
      const path = filename.split(sep).join("/");
      if (!validRelativePath(path)) return;
      const kind = metadata.notification(path);
      if (kind === "head") {
        metadataDirty = true;
        schedule();
        return;
      }
      if (kind === "visibility") {
        full = true;
        metadataDirty = true;
      } else if (internal(path)) return;
      if (!path || path.split("/").at(-1) === ".gitignore") full = true;
      if (dirty.size < 100_000) dirty.add(path);
      else full = true;
    } else {
      full = true;
      metadataDirty = true;
    }
    schedule();
  }
  function polling(reason: string): void {
    if (disposed || mode === "polling") return;
    mode = "polling";
    native?.close();
    metadata.close();
    native = undefined;
    directories = undefined;
    warning(
      `Workspace recursive watch unavailable; falling back to polling with backoff: ${reason}`,
    );
    armPoll();
  }
  try {
    const root = await safe.resolve("");
    if (forcePolling) polling("polling explicitly requested");
    else {
      try {
        if (safe.runtime.platform === "linux") {
          directories = new DirectoryWatches(root, safe.runtime, notified, polling);
          native = directories;
          directories.start();
        } else {
          const recursive = safe.runtime.watch(root, { recursive: true }, (_event, filename) =>
            notified(filename === null ? null : filename.toString()),
          );
          native = recursive;
          recursive.on("error", (error) => polling(error.message));
        }
        await metadata.refresh();
      } catch (error) {
        polling(String(error));
      }
    }
    // Subscribe first, then scan, retaining notifications that race initialization.
    const initial = await fullSnapshot(safe, ignore, lifetime.signal);
    previous = new VisibleTree(initial.values());
    // Per-directory watches start after the inventory read their folders: one rescan of them
    // catches entries that raced it, before the subscription is handed out.
    follow(initial.values(), []);
    if (revisit.size) await scan();
    initializing = false;
    if (dirty.size || revisit.size || full || metadataDirty) schedule();
  } catch (error) {
    disposed = true;
    native?.close();
    metadata.close();
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
      metadata.close();
      interval?.();
      timer?.();
      await tail;
      dirty.clear();
      revisit.clear();
      previous = new VisibleTree([]);
    },
  };
}
