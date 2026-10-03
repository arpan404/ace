import { watch, type FSWatcher } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { ProviderHome } from "./contracts.ts";

export type InventoryChanges = { instanceId: string; paths: string[] }[];
/** Watches outlive idle workers. A restart or uncertain watch always requires a full inventory. */
export class InventoryWatch {
  private watchers: FSWatcher[] = [];
  private dirty = new Map<string, Set<string>>();
  private primed = false;
  private uncertain = false;
  private unsupported = false;
  private listeners = new Set<() => void>();
  constructor(instances: ProviderHome[]) {
    for (const instance of instances) {
      if (instance.provider === "cursor") continue;
      try {
        const watcher = watch(instance.homeDir, { recursive: true }, (_event, filename) => {
          if (!filename) {
            this.invalidate();
            return;
          }
          const path = resolve(instance.homeDir, filename);
          const name = relative(instance.homeDir, path).split(sep).join("/");
          if (name.startsWith("../") || name === "..") {
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
          let paths = this.dirty.get(instance.id);
          if (!paths) {
            paths = new Set();
            this.dirty.set(instance.id, paths);
          }
          if (paths.size >= 4096) {
            this.invalidate();
            return;
          }
          paths.add(database ? path.replace(/-(?:wal|journal)$/, "") : path);
          this.notify();
        });
        watcher.on("error", () => {
          this.unsupported = true;
          this.notify();
        });
        watcher.unref();
        this.watchers.push(watcher);
      } catch {
        this.unsupported = true;
      }
    }
  }
  private invalidate(): void {
    this.uncertain = true;
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 16) throw new Error("Too many history watch subscribers");
    this.listeners.add(listener);
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
    this.uncertain = false;
    return full ? undefined : changes;
  }
  commit(): void {
    this.primed = true;
  }
  reset(): void {
    this.primed = false;
  }
  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.dirty.clear();
    this.listeners.clear();
  }
}
