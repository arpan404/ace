import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRuntime } from "./runtime.ts";
import type { Entry } from "./types.ts";
import { errorCode } from "./types.ts";

/** A relative "/"-separated path that changed, or null when the whole tree is suspect. */
export type DirectoryNotification = (path: string | null) => void;

/**
 * Linux's recursive fs.watch places an inotify watch on every directory, including
 * ignored trees such as node_modules, and exhausts the per-user watch budget on
 * large repositories. This keeps one non-recursive watch per visible directory and
 * follows the visible tree as scans add and remove directories.
 */
export class DirectoryWatches {
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private readonly root: string;
  private readonly runtime: Pick<WorkspaceRuntime, "watch">;
  private readonly notify: DirectoryNotification;
  private readonly failed: (reason: string) => void;
  constructor(
    root: string,
    runtime: Pick<WorkspaceRuntime, "watch">,
    notify: DirectoryNotification,
    failed: (reason: string) => void,
  ) {
    this.root = root;
    this.runtime = runtime;
    this.notify = notify;
    this.failed = failed;
  }
  get size(): number {
    return this.watchers.size;
  }
  /** Watches the root itself; failures here are fatal to native watching. */
  start(): void {
    const watcher = this.runtime.watch(this.root, { recursive: false }, (_event, filename) => {
      this.notify(filename === null ? null : filename.toString());
    });
    watcher.on("error", (error) => this.failed(error.message));
    this.watchers.set("", watcher);
  }
  /**
   * Applies one scan's result. Returns directories that became watched: entries
   * created inside them before their watch existed must be rescanned.
   */
  sync(updates: Iterable<Entry>, removed: Iterable<string>): string[] {
    if (this.closed) return [];
    for (const path of removed) {
      const watcher = this.watchers.get(path);
      if (!watcher || path === "") continue;
      watcher.close();
      this.watchers.delete(path);
    }
    const added: string[] = [];
    for (const entry of updates) {
      if (entry.type !== "directory" || this.watchers.has(entry.path)) continue;
      if (this.add(entry.path)) added.push(entry.path);
      if (this.closed) break;
    }
    return added;
  }
  private add(dir: string): boolean {
    let watcher: FSWatcher;
    try {
      watcher = this.runtime.watch(
        join(this.root, dir),
        { recursive: false },
        (_event, filename) => {
          this.notify(filename === null ? dir : `${dir}/${filename.toString()}`);
        },
      );
    } catch (error) {
      const code = errorCode(error);
      // The directory vanished or became unreadable; its parent's watch reports that.
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
        return false;
      this.failed(
        code === "ENOSPC"
          ? "inotify watch limit reached (raise fs.inotify.max_user_watches)"
          : String(error),
      );
      return false;
    }
    watcher.on("error", (error) => {
      if (this.closed || this.watchers.get(dir) !== watcher) return;
      if (errorCode(error) !== "ENOENT") return this.failed(error.message);
      watcher.close();
      this.watchers.delete(dir);
      this.notify(dir);
    });
    this.watchers.set(dir, watcher);
    return true;
  }
  close(): void {
    this.closed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
