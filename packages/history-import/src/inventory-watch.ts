import { watch } from "node:fs";
import { resolve, relative, sep, dirname } from "node:path";
import type { ProviderHome } from "./contracts.ts";

export type WatchDirectory = (
  path: string,
  changed: (event: "rename" | "change", filename: string | null) => void,
  failed: () => void,
) => () => void;
const watchDirectory: WatchDirectory = (path, changed, failed) => {
  const watcher = watch(path, { recursive: true }, changed);
  watcher.on("error", failed);
  watcher.unref();
  return () => watcher.close();
};

export type InventoryChanges = { instanceId: string; paths: string[] }[];
/** Watches outlive idle workers. A restart or uncertain watch always requires a full inventory. */
export class InventoryWatch {
  private watchers: (() => void)[] = [];
  private dirty = new Map<string, Set<string>>();
  private dirtyCount = 0;
  private primed = false;
  private uncertain = false;
  private unsupported = false;
  private listeners = new Set<() => void>();
  constructor(instances: ProviderHome[], watchSource: WatchDirectory = watchDirectory) {
    for (const instance of instances) {
      if (instance.provider === "cursor") continue;
      try {
        const stop = watchSource(
          instance.homeDir,
          (event, filename) => {
            if (!filename) {
              this.invalidate();
              return;
            }
            if (this.uncertain) return;
            const path = resolve(instance.homeDir, filename);
            const name = relative(instance.homeDir, path).split(sep).join("/");
            if (name.startsWith("../") || name === "..") {
              this.invalidate();
              return;
            }
            if (instance.provider === "codex" && name === "session_index.jsonl") {
              this.invalidate();
              return;
            }
            if (instance.provider === "opencode") {
              // Legacy part changes cannot be mapped to sessions without its source inventory.
              if (name.startsWith("storage/")) {
                this.invalidate();
                return;
              }
            }
            const transcript =
              instance.provider === "claude"
                ? name === "projects" || name.startsWith("projects/")
                : name === "sessions" ||
                  name.startsWith("sessions/") ||
                  name === "archived_sessions" ||
                  name.startsWith("archived_sessions/");
            const database =
              instance.provider === "codex"
                ? /^state_\d+\.sqlite(?:-wal|-journal)?$/.test(name)
                : /^opencode(?:-[\w-]+)?\.db(?:-wal|-journal)?$/.test(name);
            if (!transcript && !database) return;
            // A coalesced rename may report only the destination. Verify its parent so
            // old names disappear, including case-only renames on case-insensitive homes.
            if (database && event === "rename") {
              this.invalidate();
              return;
            }
            let paths = this.dirty.get(instance.id);
            if (!paths) {
              paths = new Set();
              this.dirty.set(instance.id, paths);
            }
            const root = name === "projects" || name === "sessions" || name === "archived_sessions";
            const changed = database
              ? path.replace(/-(?:wal|journal)$/, "")
              : event === "rename" && !root
                ? dirname(path)
                : path;
            if (paths.has(changed)) return;
            if (this.dirtyCount >= 4096) {
              this.invalidate();
              return;
            }
            paths.add(changed);
            this.dirtyCount++;
            this.notify();
          },
          () => {
            this.unsupported = true;
            this.invalidate();
          },
        );
        this.watchers.push(stop);
      } catch {
        this.unsupported = true;
      }
    }
  }
  private invalidate(): void {
    this.uncertain = true;
    this.dirty.clear();
    this.dirtyCount = 0;
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 16) throw new Error("Too many history watch subscribers");
    this.listeners.add(listener);
    // Notifications are level-triggered. A deduplicated path may already be dirty
    // before this subscriber exists; it must not wait for another distinct path.
    if (this.dirtyCount || this.uncertain || this.unsupported) listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  take(): InventoryChanges | undefined {
    const full = !this.primed || this.uncertain || this.unsupported;
    const changes = [...this.dirty].map(([instanceId, paths]) => ({
      instanceId,
      paths: [...paths],
    }));
    this.dirty.clear();
    this.dirtyCount = 0;
    this.uncertain = false;
    return full ? undefined : changes;
  }
  retry(entries: { instanceId: string; path: string }[]): void {
    for (const entry of entries) {
      let paths = this.dirty.get(entry.instanceId);
      if (!paths) {
        paths = new Set();
        this.dirty.set(entry.instanceId, paths);
      }
      if (!paths.has(entry.path) && this.dirtyCount < 4096) {
        paths.add(entry.path);
        this.dirtyCount++;
      }
    }
    if (this.dirtyCount) this.notify();
  }
  commit(): void {
    this.primed = true;
  }
  reset(): void {
    this.primed = false;
  }
  close(): void {
    for (const stop of this.watchers) stop();
    this.watchers = [];
    this.dirty.clear();
    this.dirtyCount = 0;
    this.listeners.clear();
  }
}
