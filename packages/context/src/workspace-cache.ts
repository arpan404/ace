import { cacheScheduler, recoveryDelay, type CacheScheduler } from "./cache-scheduler.ts";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { GitWorkspace, type WorkspaceFiles } from "./git-workspace.ts";
import { requireContext } from "./errors.ts";

const WatchedPath = z.string().max(1024);

interface Cached {
  workspace: WorkspaceFiles;
  watcher: FSWatcher;
  pending: Set<string>;
  rebuild: boolean;
  task: Promise<void>;
  ready: boolean;
  cancelRetry: (() => void) | undefined;
}
/** Client requests and watch events share the same workspace index. LRU eviction closes watchers. */
export class WorkspaceCache {
  private cache = new Map<string, Cached>();
  private cap: number;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private scheduler: CacheScheduler;
  private watchRoot: (root: string) => FSWatcher;
  private create: (root: string) => WorkspaceFiles;
  constructor(
    cap = 4,
    create: (root: string) => WorkspaceFiles = (root) => new GitWorkspace(root),
    scheduler: CacheScheduler = cacheScheduler,
    watchRoot: (root: string) => FSWatcher = (root) => watch(root, { recursive: true }),
  ) {
    this.create = create;
    this.scheduler = scheduler;
    this.watchRoot = watchRoot;
    requireContext(
      Number.isInteger(cap) && cap > 0 && cap <= 16,
      "invalid_request",
      "Invalid workspace cache cap",
    );
    this.cap = cap;
  }
  async get(root: string): Promise<WorkspaceFiles> {
    requireContext(!this.closed, "busy", "Workspace cache closed");
    const cached = this.cache.get(resolve(root));
    if (cached?.ready) {
      this.cache.delete(resolve(root));
      this.cache.set(resolve(root), cached);
      return cached.workspace;
    }
    requireContext(this.queued < 32, "busy", "Workspace cache busy");
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
      return cached.workspace;
    }
    if (this.cache.size >= this.cap) {
      const first = this.cache.entries().next().value;
      if (first) {
        first[1].cancelRetry?.();
        first[1].watcher.close();
        this.cache.delete(first[0]);
        await first[1].task;
      }
    }
    const workspace = this.create(root);
    const pending = new Set<string>();
    const watcher = this.watchRoot(root);
    cached = {
      workspace,
      watcher,
      pending,
      rebuild: false,
      task: Promise.resolve(),
      ready: false,
      cancelRetry: undefined,
    };
    const entry = cached;
    let running = false;
    let failures = 0;
    const flush = (): Promise<void> => {
      // Churn queues bounded changes without bypassing failure backoff.
      if (running || entry.cancelRetry || this.closed || this.cache.get(root) !== entry)
        return entry.task;
      if (!entry.rebuild && pending.size === 0) return entry.task;
      running = true;
      entry.task = entry.task
        .then(async () => {
          while (
            !this.closed &&
            this.cache.get(root) === entry &&
            (entry.rebuild || pending.size)
          ) {
            const rebuild = entry.rebuild;
            entry.rebuild = false;
            const paths = [...pending];
            pending.clear();
            if (rebuild) {
              await workspace.initialize();
              if (this.closed || this.cache.get(root) !== entry) return;
              // Re-arm even after watcher errors or a lost notification source.
              entry.watcher.close();
              entry.watcher = this.watchRoot(root);
              listen(entry.watcher);
            } else await workspace.update(paths);
          }
          failures = 0;
        })
        .catch(() => {
          if (this.closed || this.cache.get(root) !== entry) return;
          entry.rebuild = true;
          failures = Math.min(7, failures + 1);
          entry.cancelRetry = this.scheduler.after(recoveryDelay(failures), () => {
            entry.cancelRetry = undefined;
            // A timer driver may fire before the failed drain has settled.
            return entry.task.then(flush);
          });
        })
        .finally(() => {
          running = false;
          // Events can arrive after the loop's last check, while the promise
          // chain is settling. Hand that work to a new drain without waiting
          // for another notification; flush still honors retry backoff.
          if (entry.rebuild || pending.size) void flush();
        });
      return entry.task;
    };
    const listen = (source: FSWatcher) => {
      source.on("change", (_event, filename) => {
        const parsed = WatchedPath.safeParse(filename);
        if (!parsed.success || pending.size >= 4096) {
          pending.clear();
          entry.rebuild = true;
        } else {
          if (parsed.data.startsWith(".git/") && !parsed.data.startsWith(".git/info/exclude"))
            return;
          pending.add(parsed.data);
        }
        void flush();
      });
      source.on("error", () => {
        entry.rebuild = true;
        void flush();
      });
    };
    listen(watcher);
    entry.task = workspace.initialize();
    this.cache.set(root, entry);
    try {
      await entry.task;
      entry.ready = true;
      void flush();
      return workspace;
    } catch (error) {
      entry.cancelRetry?.();
      entry.watcher.close();
      this.cache.delete(root);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    for (const entry of this.cache.values()) {
      entry.cancelRetry?.();
      entry.watcher.close();
      await entry.task;
    }
    this.cache.clear();
  }
}
