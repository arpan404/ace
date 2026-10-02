import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { GitWorkspace, type WorkspaceFiles } from "./git-workspace.ts";
import { requireContext } from "./errors.ts";

interface Cached {
  workspace: WorkspaceFiles;
  watcher: FSWatcher;
  pending: Set<string>;
  rebuild: boolean;
  task: Promise<void>;
}
/** Client requests and watch events share the same workspace index. LRU eviction closes watchers. */
export class WorkspaceCache {
  private cache = new Map<string, Cached>();
  private cap: number;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(cap = 4) {
    requireContext(
      Number.isInteger(cap) && cap > 0 && cap <= 16,
      "invalid_request",
      "Invalid workspace cache cap",
    );
    this.cap = cap;
  }
  async get(root: string): Promise<WorkspaceFiles> {
    requireContext(!this.closed && this.queued < 32, "busy", "Workspace cache busy");
    this.queued++;
    const result = this.tail
      .then(() => this.load(root))
      .finally(() => {
        this.queued--;
      });
    this.tail = result.catch(() => {});
    return result;
  }
  private async load(root: string): Promise<WorkspaceFiles> {
    root = resolve(root);
    let cached = this.cache.get(root);
    if (cached) {
      this.cache.delete(root);
      this.cache.set(root, cached);
      await cached.task;
      if (cached.rebuild) {
        await cached.workspace.initialize();
        cached.rebuild = false;
      }
      return cached.workspace;
    }
    if (this.cache.size >= this.cap) {
      const first = this.cache.entries().next().value;
      if (first) {
        first[1].watcher.close();
        await first[1].task;
        this.cache.delete(first[0]);
      }
    }
    const workspace = new GitWorkspace(root);
    const pending = new Set<string>();
    const watcher = watch(root, { recursive: true });
    cached = { workspace, watcher, pending, rebuild: false, task: Promise.resolve() };
    const entry = cached;
    let running = false;
    const flush = () => {
      if (running || this.closed) return;
      running = true;
      entry.task = entry.task
        .then(async () => {
          while (entry.rebuild || pending.size) {
            const rebuild = entry.rebuild;
            entry.rebuild = false;
            const paths = [...pending];
            pending.clear();
            if (rebuild) await workspace.initialize();
            else await workspace.update(paths);
          }
        })
        .catch(() => {
          entry.rebuild = true;
        })
        .finally(() => {
          running = false;
        });
    };
    watcher.on("change", (_event, filename) => {
      const parsed = z.string().max(1024).safeParse(filename);
      if (!parsed.success || pending.size >= 4096) {
        pending.clear();
        entry.rebuild = true;
      } else {
        if (parsed.data.startsWith(".git/") && !parsed.data.startsWith(".git/info/exclude")) return;
        pending.add(parsed.data);
      }
      flush();
    });
    watcher.on("error", () => {
      entry.rebuild = true;
    });
    entry.task = workspace.initialize();
    this.cache.set(root, entry);
    try {
      await entry.task;
      flush();
      return workspace;
    } catch (error) {
      watcher.close();
      this.cache.delete(root);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    for (const entry of this.cache.values()) {
      entry.watcher.close();
      await entry.task;
    }
    this.cache.clear();
  }
}
