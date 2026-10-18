import { cacheScheduler, recoveryDelay, type CacheScheduler } from "./cache-scheduler.ts";
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { GitWorkspace, type WorkspaceFiles } from "./git-workspace.ts";
import { requireContext } from "./errors.ts";

const WatchedPath = z.string().max(1024);

export interface WorkspaceCacheLimits {
  /** An entry nobody has used for this long closes its watcher and drops its index. */
  idleMs?: number;
  /**
   * Estimated index bytes retained across all roots. The most recently used
   * root is always kept whole, so one large repository still completes fully.
   */
  maxBytes?: number;
  /** Watcher hints arriving within this window reconcile as one batch. */
  coalesceMs?: number;
  /** Timer boundary for idle expiry and coalescing; retry backoff keeps its own. */
  timers?: CacheScheduler;
}
export const defaultWorkspaceCacheLimits = {
  idleMs: 120_000,
  maxBytes: 128 * 1024 * 1024,
  coalesceMs: 200,
};

interface Cached {
  workspace: WorkspaceFiles;
  watcher: FSWatcher;
  pending: Set<string>;
  rebuild: boolean;
  task: Promise<void>;
  ready: boolean;
  leases: number;
  cancelRetry: (() => void) | undefined;
  cancelIdle: (() => void) | undefined;
  cancelCoalesce: (() => void) | undefined;
}
/**
 * Client requests and watch events share the same workspace index. Entries
 * retire, closing their watcher, on LRU count, idle expiry or byte pressure; a
 * later request rebuilds from current filesystem and ignore state.
 */
export class WorkspaceCache {
  private cache = new Map<string, Cached>();
  private retiring = new Set<Promise<void>>();
  private cap: number;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private scheduler: CacheScheduler;
  private timers: CacheScheduler;
  private idleMs: number;
  private coalesceMs: number;
  private maxBytes: number;
  private watchRoot: (root: string) => FSWatcher;
  private create: (root: string) => WorkspaceFiles;
  constructor(
    cap = 4,
    create: (root: string) => WorkspaceFiles = (root) => new GitWorkspace(root),
    scheduler: CacheScheduler = cacheScheduler,
    watchRoot: (root: string) => FSWatcher = (root) => watch(root, { recursive: true }),
    limits: WorkspaceCacheLimits = {},
  ) {
    this.create = create;
    this.scheduler = scheduler;
    this.watchRoot = watchRoot;
    this.timers = limits.timers ?? cacheScheduler;
    this.idleMs = limits.idleMs ?? defaultWorkspaceCacheLimits.idleMs;
    this.coalesceMs = limits.coalesceMs ?? defaultWorkspaceCacheLimits.coalesceMs;
    this.maxBytes = limits.maxBytes ?? defaultWorkspaceCacheLimits.maxBytes;
    requireContext(
      Number.isInteger(cap) &&
        cap > 0 &&
        cap <= 16 &&
        Number.isInteger(this.idleMs) &&
        this.idleMs > 0 &&
        Number.isInteger(this.coalesceMs) &&
        this.coalesceMs >= 0 &&
        Number.isInteger(this.maxBytes) &&
        this.maxBytes > 0,
      "invalid_request",
      "Invalid workspace cache limits",
    );
    this.cap = cap;
  }
  /** Returns the published workspace; prefer `use` so expiry waits for the caller. */
  async get(root: string): Promise<WorkspaceFiles> {
    const [key, entry] = await this.entry(root);
    this.touch(key, entry);
    return entry.workspace;
  }
  /** Runs `task` while holding the entry, so idle or byte eviction cannot retire it. */
  async use<T>(root: string, task: (workspace: WorkspaceFiles) => T | Promise<T>): Promise<T> {
    const [key, entry] = await this.entry(root);
    entry.leases++;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    try {
      return await task(entry.workspace);
    } finally {
      entry.leases--;
      // Finishing a request is the latest use: it moves the entry to MRU.
      if (this.cache.get(key) === entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
      }
      this.touch(key, entry);
      this.enforceBudget();
    }
  }
  private async entry(root: string): Promise<[string, Cached]> {
    requireContext(!this.closed, "busy", "Workspace cache closed");
    const key = resolve(root);
    const cached = this.cache.get(key);
    if (cached?.ready) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return [key, cached];
    }
    requireContext(this.queued < 32, "busy", "Workspace cache busy");
    this.queued++;
    const result = this.tail
      .then(() => this.load(key))
      .finally(() => {
        this.queued--;
      });
    this.tail = result.catch(() => {});
    return [key, await result];
  }
  /** Re-arms the single idle deadline of an entry nobody currently holds. */
  private touch(root: string, entry: Cached): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    if (this.closed || entry.leases > 0 || this.cache.get(root) !== entry) return;
    entry.cancelIdle = this.timers.after(this.idleMs, async () => {
      entry.cancelIdle = undefined;
      if (this.cache.get(root) === entry && entry.leases === 0) void this.retire(root, entry);
    });
  }
  /** Unpublishes an entry now; its in-flight drain settles before `close` returns. */
  private retire(root: string, entry: Cached): Promise<void> {
    entry.cancelRetry?.();
    entry.cancelRetry = undefined;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.cancelCoalesce?.();
    entry.cancelCoalesce = undefined;
    entry.watcher.close();
    if (this.cache.get(root) === entry) this.cache.delete(root);
    const settled: Promise<void> = entry.task
      .catch(() => {})
      .finally(() => {
        this.retiring.delete(settled);
      });
    this.retiring.add(settled);
    return settled;
  }
  /** Least recently used, unheld entries go first; the newest entry always stays. */
  private enforceBudget(): void {
    let total = 0,
      newest: Cached | undefined;
    for (const entry of this.cache.values()) {
      if (entry.ready) total += entry.workspace.index.estimatedBytes;
      newest = entry;
    }
    for (const [root, entry] of this.cache) {
      if (total <= this.maxBytes) return;
      if (entry === newest || !entry.ready || entry.leases > 0) continue;
      total -= entry.workspace.index.estimatedBytes;
      void this.retire(root, entry);
    }
  }
  private async load(root: string): Promise<Cached> {
    let cached = this.cache.get(root);
    if (cached) {
      this.cache.delete(root);
      this.cache.set(root, cached);
      return cached;
    }
    if (this.cache.size >= this.cap) {
      let victim: [string, Cached] | undefined;
      for (const candidate of this.cache) {
        victim ??= candidate;
        if (candidate[1].leases === 0) {
          victim = candidate;
          break;
        }
      }
      if (victim) await this.retire(victim[0], victim[1]);
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
      leases: 0,
      cancelRetry: undefined,
      cancelIdle: undefined,
      cancelCoalesce: undefined,
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
            // Everything queued during the coalescing window is one batch.
            const paths = [...pending];
            pending.clear();
            if (rebuild) {
              // Subscribe before inventory so changes beyond its cut are queued.
              const replacement = this.watchRoot(root);
              listen(replacement);
              const superseded = entry.watcher;
              entry.watcher = replacement;
              superseded.close();
              await workspace.initialize();
            } else {
              await workspace.update(paths);
              // Later hints wait for their own window rather than chaining.
              break;
            }
          }
          failures = 0;
          this.enforceBudget();
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
          if (entry.rebuild) void flush();
          else if (pending.size) hint();
        });
      return entry.task;
    };
    /** Bounds reconciliation to one batch per window under sustained churn. */
    const hint = (): void => {
      if (running || entry.cancelCoalesce || this.closed || this.cache.get(root) !== entry) return;
      entry.cancelCoalesce = this.timers.after(this.coalesceMs, () => {
        entry.cancelCoalesce = undefined;
        return flush();
      });
    };
    const listen = (source: FSWatcher) => {
      source.on("change", (_event, filename) => {
        if (this.closed || this.cache.get(root) !== entry || entry.watcher !== source) return;
        const parsed = WatchedPath.safeParse(filename);
        if (!parsed.success || pending.size >= 4096) {
          pending.clear();
          entry.rebuild = true;
        } else {
          if (parsed.data.startsWith(".git/") && !parsed.data.startsWith(".git/info/exclude"))
            return;
          pending.add(parsed.data);
          hint();
          return;
        }
        void flush();
      });
      source.on("error", () => {
        if (this.closed || this.cache.get(root) !== entry || entry.watcher !== source) return;
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
      this.enforceBudget();
      void flush();
      return entry;
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
    for (const [root, entry] of this.cache) void this.retire(root, entry);
    await Promise.all(this.retiring);
  }
}
