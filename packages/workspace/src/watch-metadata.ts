import type { FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { GitIgnore } from "./ignore.ts";
import type { SafeRoot } from "./safety.ts";
import { errorCode } from "./types.ts";

type MetadataChange = "head" | "visibility";

/** External Git sources are never workspace changes; they invalidate visibility. */
export class WatchMetadata {
  private paths = new Set<string>();
  private head: string | undefined;
  private ignoreConfiguration: string | undefined;
  private subscriptions = new Map<string, { watcher: FSWatcher; names: Set<string> }>();
  private closed = false;
  constructor(
    safe: SafeRoot,
    ignore: GitIgnore,
    signal: AbortSignal,
    changed: (kind: MetadataChange) => void,
    failed: (reason: string) => void,
  ) {
    this.safe = safe;
    this.ignore = ignore;
    this.signal = signal;
    this.changed = changed;
    this.failed = failed;
  }
  private readonly safe: SafeRoot;
  private readonly ignore: GitIgnore;
  private readonly signal: AbortSignal;
  private readonly changed: (kind: MetadataChange) => void;
  private readonly failed: (reason: string) => void;

  private classify(target: string): MetadataChange | undefined {
    if (this.head && (target === this.head || target === `${this.head}.lock`)) return "head";
    if (this.paths.has(target) || (target.endsWith(".lock") && this.paths.has(target.slice(0, -5))))
      return "visibility";
    return undefined;
  }
  notification(path: string): MetadataChange | undefined {
    return this.classify(join(this.safe.root, path));
  }
  async refresh(): Promise<boolean> {
    const discovery = await this.ignore.metadata(this.signal);
    const paths = discovery.paths;
    const folders = new Map<string, Set<string>>();
    for (const path of paths) {
      const local = relative(this.safe.root, path);
      if (local !== ".." && !local.startsWith(".." + sep) && !isAbsolute(local)) continue;
      let dir = dirname(path);
      // Watch the nearest existing parent so missing Git config/ignore folders
      // can appear without forcing native mode to fall back to polling.
      for (;;) {
        try {
          await this.safe.runtime.filesystem.stat(dir);
          break;
        } catch (error) {
          if (errorCode(error) !== "ENOENT" || dirname(dir) === dir) throw error;
          dir = dirname(dir);
        }
      }
      const name = relative(dir, path).split(sep)[0] ?? basename(path);
      const names = folders.get(dir) ?? new Set<string>();
      names.add(name);
      names.add(name + ".lock");
      folders.set(dir, names);
    }
    if (this.closed || this.signal.aborted) return false;
    // Establish replacements before releasing superseded notification sources.
    for (const [dir, names] of folders) {
      const current = this.subscriptions.get(dir);
      if (current) {
        current.names = names;
        continue;
      }
      const source = {
        names,
        watcher: this.safe.runtime.watch(dir, { recursive: false }, (_event, filename) => {
          if (filename === null) this.changed("visibility");
          else if (source.names.has(filename))
            this.changed(this.classify(join(dir, filename)) ?? "visibility");
        }),
      };
      source.watcher.on("error", (error) => this.failed(error.message));
      this.subscriptions.set(dir, source);
    }
    this.paths = new Set(paths);
    this.head = discovery.head;
    for (const [dir, source] of this.subscriptions) {
      if (folders.has(dir)) continue;
      source.watcher.close();
      this.subscriptions.delete(dir);
    }
    const changed = this.ignoreConfiguration !== discovery.ignoreConfiguration;
    this.ignoreConfiguration = discovery.ignoreConfiguration;
    return changed;
  }
  close(): void {
    this.closed = true;
    for (const source of this.subscriptions.values()) source.watcher.close();
    this.subscriptions.clear();
  }
}
