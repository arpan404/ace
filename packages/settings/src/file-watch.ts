import { watch, watchFile, unwatchFile } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
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

/** Ancestor notifications can miss directory creation; stat polling bridges
 * that gap only until the destination's own parent can be watched. */
export function createFileWatcher(directory: DirectoryWatch = watchDirectory) {
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
            for (const listener of [...listeners]) listener.changed(filename);
          },
          () => {
            // Failed sources cannot satisfy a subsequent retry. Existing leases
            // keep their source until the last release; retries acquire a new one.
            if (parents.get(key) === owned) parents.delete(key);
            for (const listener of [...listeners]) listener.failed();
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
    const polling = parent !== dirname(path);
    try {
      if (polling) watchFile(path, { persistent: false, interval: 500 }, changed);
    } catch (error) {
      stopDirectory();
      throw error;
    }
    return () => {
      stopDirectory();
      if (polling) unwatchFile(path, changed);
    };
  };
}
