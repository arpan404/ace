import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, relative, sep, join } from "node:path";
import { SettingsError } from "./validation.ts";

type DirectoryWatch = (
  path: string,
  changed: (filename: string | null) => void,
  failed: () => void,
) => () => void;

const watchDirectory: DirectoryWatch = (path, changed, failed) => {
  const watcher = watch(path, (_event, filename) => changed(filename));
  watcher.on("error", failed);
  return () => watcher.close();
};
type MissingFilePoll = (path: string, changed: () => void) => () => void;
async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    // Other errors must trigger the normal reload diagnostic path.
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}
function repeatPoll(tick: () => Promise<void>): () => void {
  const timer = setInterval(() => {
    void tick();
  }, 500);
  timer.unref();
  return () => clearInterval(timer);
}
/** The watcher has already observed this ancestor missing. No asynchronous
 * baseline sample can swallow creation between registration and the first tick. */
function createMissingDirectoryPoll(
  exists: (path: string) => Promise<boolean> = directoryExists,
  repeat: (tick: () => Promise<void>) => () => void = repeatPoll,
): MissingFilePoll {
  return (path, changed) => {
    let stopped = false;
    let checking: Promise<void> | undefined;
    const tick = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      checking ??= exists(path)
        .then((present) => {
          if (present && !stopped) {
            stopped = true;
            stop();
            changed();
          }
        })
        .finally(() => {
          checking = undefined;
        });
      return checking;
    };
    const stop = repeat(tick);
    // Reconcile after registration as well as on subsequent ticks.
    void tick();
    return () => {
      stopped = true;
      stop();
    };
  };
}

/** Ancestor notifications can miss directory creation; stat polling bridges
 * that gap only until the destination's own parent can be watched. */
export function createFileWatcher(
  directory: DirectoryWatch = watchDirectory,
  poll?: MissingFilePoll,
  repeat: (tick: () => Promise<void>) => () => void = repeatPoll,
) {
  const missingPoll = poll ?? createMissingDirectoryPoll(directoryExists, repeat);
  // Missing thread scopes share the same ancestor. Opening one native watch per
  // file repeatedly rebuilds the macOS FSEvents stream as the file LRU turns over.
  const parents = new Map<
    string,
    {
      listeners: Set<{ changed(filename: string | null): void; failed(): void }>;
      stop(): void;
    }
  >();
  function acquire(
    parent: string,
    identity: string,
    changed: (filename: string | null) => void,
    failed: () => void,
  ) {
    const key = `${identity}:${parent}`;
    let entry = parents.get(key);
    if (!entry) {
      if (parents.size >= 128) throw new SettingsError("limit", "Settings watcher limit reached");
      const listeners = new Set<{ changed(filename: string | null): void; failed(): void }>();
      const owned = {
        listeners,
        stop: directory(
          parent,
          (filename) => {
            for (const listener of Array.from(listeners)) listener.changed(filename);
          },
          () => {
            // Failed sources cannot satisfy a subsequent retry. Existing leases
            // keep their source until the last release; retries acquire a new one.
            if (parents.get(key) === owned) parents.delete(key);
            for (const listener of Array.from(listeners)) listener.failed();
          },
        ),
      };
      entry = owned;
      parents.set(key, entry);
    }
    if (entry.listeners.size >= 128)
      throw new SettingsError("limit", "Settings watcher subscriber limit reached");
    const listener = { changed, failed };
    entry.listeners.add(listener);
    const leased = entry;
    return () => {
      if (!leased.listeners.delete(listener) || leased.listeners.size) return;
      if (parents.get(key) === leased) parents.delete(key);
      leased.stop();
    };
  }
  return async (path: string, changed: () => void, failed: () => void): Promise<() => void> => {
    let parent = dirname(path);
    let identity = "";
    while (true) {
      try {
        const metadata = await stat(parent);
        identity = `${metadata.dev}:${metadata.ino}`;
        break;
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
          dirname(parent) === parent
        )
          throw error;
        parent = dirname(parent);
      }
    }
    const child = relative(parent, path).split(sep)[0];
    const stopDirectory = acquire(
      parent,
      identity,
      (filename) => {
        if (!filename || filename.split(sep)[0] === child) changed();
      },
      failed,
    );
    let stopPolling: (() => void) | undefined;
    try {
      if (parent !== dirname(path)) stopPolling = missingPoll(join(parent, child ?? ""), changed);
    } catch (error) {
      stopDirectory();
      throw error;
    }
    return () => {
      stopDirectory();
      stopPolling?.();
    };
  };
}
