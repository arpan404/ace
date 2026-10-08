import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CommandCatalog } from "./catalog.ts";
import type { DiscoveryRoot } from "./roots.ts";
import { FileRecovery } from "./recovery.ts";
import { SecureCommandIo, type CommandFileIo } from "./secure-io.ts";
import { FileIndex, type DiscoveryMetrics } from "./file-index.ts";
import { inside, key, sourceId, type RegisteredRoot } from "./file-keys.ts";
const rootSchema = z.object({
  path: z.string().min(1).max(4096),
  format: z.enum(["library", "claude", "codex", "opencode", "opencode-config", "cursor", "pi"]),
  scope: z.enum(["user", "workspace"]),
  instance: z.string().max(128).optional(),
  skill: z.boolean().optional(),
  kind: z
    .enum(["skill", "command", "plugin", "agent", "workflow", "mcp-tool", "builtin"])
    .optional(),
  plugin: z.string().max(256).optional(),
  trustedRoot: z.string().max(4096).optional(),
});
export type WatchSource = (
  path: string,
  changed: (file: string | undefined) => void,
  failed: () => void,
) => () => void;
const nativeWatch: WatchSource = (path, changed, failed) => {
  const watcher = watch(path, (_event, file) => changed(file === null ? undefined : String(file)));
  watcher.on("error", failed);
  watcher.unref();
  return () => watcher.close();
};
export type RecoveryScheduler = (run: () => void) => () => void;
const scheduleRecovery: RecoveryScheduler = (run) => {
  const timer = setInterval(run, 250);
  timer.unref();
  return () => clearInterval(timer);
};
/** Thin watcher/lifecycle shell; FileIndex advances bounded incremental discovery jobs. */
export class CommandFiles {
  private readonly roots: RegisteredRoot[];
  private readonly watchers = new Map<string, () => void>();
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly recovery = new FileRecovery();
  private readonly index: FileIndex;
  private readonly io: CommandFileIo;
  private readonly watchSource: WatchSource;
  private readonly scheduleRecovery: RecoveryScheduler;
  private timer: NodeJS.Timeout | undefined;
  private continuation: NodeJS.Immediate | undefined;
  private batch: Promise<void> | undefined;
  private flushing: Promise<void> | undefined;
  private healing: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopRecovery: (() => void) | undefined;
  private closed = false;
  constructor(
    catalog: CommandCatalog,
    roots: readonly DiscoveryRoot[],
    options: { watch?: WatchSource; schedule?: RecoveryScheduler; io?: CommandFileIo } = {},
  ) {
    this.watchSource = options.watch ?? nativeWatch;
    this.scheduleRecovery = options.schedule ?? scheduleRecovery;
    this.io = options.io ?? new SecureCommandIo();
    this.roots = z
      .array(rootSchema)
      .max(32)
      .parse(roots)
      .map((root) => {
        const path = resolve(root.path);
        return Object.assign(root, { path, id: sourceId(root, path) });
      });
    for (const root of this.roots) this.recovery.track(root.path, undefined);
    this.index = new FileIndex(catalog, this.io, this.recovery, this.roots, {
      watch: (root, path) => this.watchDirectory(root, path),
      unwatch: (root, path) => {
        const slot = key(root, path);
        this.watchers.get(slot)?.();
        this.watchers.delete(slot);
      },
      missing: (root) => this.watchAncestor(root),
    });
  }
  metrics(): DiscoveryMetrics {
    return this.index.metrics();
  }
  private watchDirectory(root: RegisteredRoot, path: string): void {
    if (this.closed) return;
    const slot = key(root, path);
    if (this.watchers.has(slot)) return;
    if (this.watchers.size >= 128) {
      this.index.report(
        root,
        path,
        "Native watcher limit exceeded; metadata recovery remains active",
      );
      return;
    }
    try {
      const stop = this.watchSource(
        path,
        (file) => {
          if (!file) {
            this.invalidate(inside(root.path, path) ? path : root.path);
            return;
          }
          const changed = resolve(path, file);
          if (inside(root.path, changed)) this.invalidate(changed);
          else if (inside(changed, root.path)) this.invalidate(root.path);
        },
        () =>
          this.index.report(
            root,
            path,
            "Native watcher unavailable; metadata recovery remains active",
          ),
      );
      if (this.closed) stop();
      else this.watchers.set(slot, stop);
    } catch {
      this.index.report(root, path, "Native watcher unavailable; metadata recovery remains active");
    }
  }
  private async watchAncestor(root: RegisteredRoot): Promise<void> {
    let parent = dirname(root.path);
    while (!this.closed) {
      try {
        if ((await lstat(parent)).isDirectory()) {
          this.watchDirectory(root, parent);
          return;
        }
      } catch {
        /* nearest existing ancestor */
      }
      const next = dirname(parent);
      if (next === parent) return;
      parent = next;
    }
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.startup ??= (async () => {
      for (const root of this.roots) {
        if (this.closed) return;
        await this.watchAncestor(root);
        this.queue(root.path);
      }
      await this.flush();
      if (!this.closed) {
        const stop = this.scheduleRecovery(() => {
          void this.reconcile();
        });
        if (this.closed) stop();
        else this.stopRecovery = stop;
      }
    })();
    return this.startup;
  }
  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error("Command files closed");
    if (this.listeners.size >= 64) throw new Error("Listener limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private queue(path: string): void {
    if (this.closed) return;
    if (this.pending.size >= 256) {
      this.pending.clear();
      for (const root of this.roots) this.pending.add(root.path);
    } else this.pending.add(resolve(path));
  }
  invalidate(path: string): void {
    this.queue(path);
    if (this.closed || this.healing || this.flushing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, 30);
    this.timer.unref();
  }
  private cancelWake(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.continuation) clearImmediate(this.continuation);
    this.timer = undefined;
    this.continuation = undefined;
  }
  private advance(): Promise<void> {
    if (this.batch) return this.batch;
    this.batch = (async () => {
      if (this.closed) return;
      for (const path of this.pending)
        for (const root of this.roots)
          if (inside(root.path, path))
            this.index.enqueue(
              root,
              path,
              path === root.path ? 0 : relative(root.path, path).split(sep).length,
            );
      this.pending.clear();
      await this.index.step();
      if (!this.closed)
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* subscribers cannot stop discovery */
          }
        }
    })().finally(() => {
      this.batch = undefined;
    });
    return this.batch;
  }
  private async pump(): Promise<void> {
    if (this.closed || this.healing || this.flushing) return;
    await this.advance();
    if (!this.closed && (this.pending.size || this.index.pending) && !this.continuation) {
      this.continuation = setImmediate(() => {
        this.continuation = undefined;
        void this.pump();
      });
      this.continuation.unref();
    }
  }
  /** Explicit callers drain all queued work; automatic discovery stays in 32-unit turns. */
  flush(): Promise<void> {
    this.cancelWake();
    this.flushing ??= (async () => {
      do {
        await this.advance();
      } while (!this.closed && (this.pending.size || this.index.pending));
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  /** One recovery tick: <=32 metadata checks and <=32 discovery work units. */
  reconcile(): Promise<void> {
    this.cancelWake();
    if (this.closed) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.healing ??= (async () => {
      for (const path of await this.recovery.check()) this.queue(path);
      await this.advance();
    })().finally(() => {
      this.healing = undefined;
    });
    return this.healing;
  }
  /** Retire definitions only when their roots are replaced; closing watchers preserves cached reads. */
  async remove(): Promise<void> {
    await this.close();
    this.index.clear();
  }
  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    this.closed = true;
    this.cancelWake();
    this.stopRecovery?.();
    this.pending.clear();
    this.listeners.clear();
    await Promise.allSettled([this.startup, this.healing, this.flushing, this.batch]);
    try {
      await this.index.close();
    } finally {
      for (const stop of this.watchers.values()) stop();
      this.watchers.clear();
      await this.io.close();
    }
  }
}
