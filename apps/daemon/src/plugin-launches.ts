import { resolve } from "node:path";
import { launchPluginProcess, type Provider } from "@ace/plugins";
import type { SpawnOptions } from "@ace/provider-kit/process";

type Launched = Awaited<ReturnType<typeof launchPluginProcess>>;
type Launcher = (provider: Provider, root: string, options: SpawnOptions) => Promise<Launched>;
/** Bounded daemon ownership; injected launch boundary keeps provider process I/O outside admission. */
export class PluginLaunches {
  private launchProcess: Launcher;
  private pending = new Set<Promise<Launched>>();
  private active = new Set<Launched>();
  private roots = new Set<string>();
  private closing: Promise<void> | undefined;
  constructor(launchProcess: Launcher) {
    this.launchProcess = launchProcess;
  }
  launch(provider: Provider, root: string, options: SpawnOptions): Promise<Launched> {
    if (this.closing) return Promise.reject(new Error("Plugin launcher is closing"));
    if (this.roots.size >= 16) return Promise.reject(new Error("Plugin launch limit"));
    const key = resolve(root);
    if (this.roots.has(key)) return Promise.reject(new Error("Plugin session root already active"));
    this.roots.add(key);
    const task = this.launchProcess(provider, root, options).then(async (handle) => {
      this.active.add(handle);
      const release = () => {
        this.active.delete(handle);
        this.roots.delete(key);
      };
      void handle.exited.then(release, release);
      if (this.closing) {
        await handle.stop({ graceMs: 0 });
        throw new Error("Plugin launcher is closing");
      }
      return handle;
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => {
        this.pending.delete(task);
        this.roots.delete(key);
      },
    );
    return task;
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled(this.pending);
      const results = await Promise.allSettled(
        [...this.active].map((handle) => handle.stop({ graceMs: 0 })),
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "Plugin launch shutdown failed");
    });
    return this.closing;
  }
}
