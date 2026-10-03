import {
  ConductorStore,
  ConductorDriver,
  type Executor,
  type Environment,
  type Fact,
  type Account,
} from "@ace/conductor";
import {
  ConductorRunView,
  ConductorCommandPayload,
  type CommandResult,
  type Command,
} from "@ace/protocol";
import type { Store } from "./store.ts";
export interface ConductorRuntimeOptions {
  execute?: Executor;
  accounts?(): readonly Account[];
}
export class ConductorRuntime {
  private storage: ConductorStore;
  private driver: ConductorDriver;
  private receipts: Store;
  private options: ConductorRuntimeOptions;
  private env: Environment;
  private listeners = new Map<string, Set<(view: ConductorRunView) => void>>();
  private tasks = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private closing = false;
  constructor(
    storage: ConductorStore,
    receipts: Store,
    env: Environment,
    options: ConductorRuntimeOptions = {},
  ) {
    this.storage = storage;
    this.receipts = receipts;
    this.env = env;
    this.options = options;
    this.driver = new ConductorDriver(
      storage,
      options.execute ??
        (async () => {
          throw new Error("conductor_executor_unavailable");
        }),
      env,
    );
    if (options.execute)
      for (const run of storage.resumable()) queueMicrotask(() => this.wake(run));
  }
  get(id: string): ConductorRunView | undefined {
    const view = this.storage.view(id);
    if (!view) return undefined;
    return ConductorRunView.parse({
      ...view,
      ...(this.errors.has(id) ? { executionError: this.errors.get(id) } : {}),
    });
  }

  list(after: string | undefined, limit: number) {
    const page = this.storage.list(after, limit);
    const runs = page.ids.flatMap((id) => {
      const summary = this.storage.summary(id);
      return summary ? [summary] : [];
    });
    return { runs, ...(page.next ? { next: page.next } : {}) };
  }
  subscribe(id: string, receive: (view: ConductorRunView) => void): () => void {
    let listeners = this.listeners.get(id);
    if (!listeners) {
      if (this.listeners.size >= 64) throw new Error("subscription_limit");
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    if (listeners.size >= 64) throw new Error("subscription_limit");
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  private publish(id: string): void {
    const listeners = this.listeners.get(id);
    if (!listeners?.size) return;
    const view = this.get(id);
    if (view) for (const listener of listeners) listener(view);
  }
  fact(id: string, receipt: string, fact: Fact): void {
    this.driver.fact(id, receipt, fact);
    this.publish(id);
    this.wake(id);
  }
  command(command: Command): CommandResult {
    const payload = ConductorCommandPayload.parse(command.payload);
    if (this.closing) return { commandId: command.id, ok: false, error: "daemon_shutting_down" };
    if (payload.type === "conductor.start" && !this.options.execute)
      return { commandId: command.id, ok: false, error: "conductor_executor_unavailable" };
    const result = this.receipts.recordCommand(command.id, command.deviceId, () => {
      try {
        this.driver.command(command.id, payload);
        if (payload.type === "conductor.start" && this.options.accounts)
          this.driver.fact(payload.runId, `accounts-${command.id}`.slice(0, 128), {
            type: "accounts",
            accounts: this.options.accounts(),
          });
        return { commandId: command.id, ok: true };
      } catch {
        return { commandId: command.id, ok: false, error: "conductor_command_failed" };
      }
    });
    this.publish(payload.runId);
    if (result.ok) this.wake(payload.runId);
    return result;
  }
  private wake(id: string): void {
    if (this.closing || this.tasks.has(id) || this.tasks.size >= 8) return;
    if (!this.options.execute) return;
    const driver = new ConductorDriver(this.storage, this.options.execute, this.env);
    let more = false;
    const task = driver
      .drain(id)
      .then((count) => {
        more = count === 128;
        this.errors.delete(id);
      })
      .catch(() => {
        if (this.errors.size >= 64) {
          const oldest = this.errors.keys().next().value;
          if (oldest) this.errors.delete(oldest);
        }
        this.errors.set(id, "conductor_execution_failed");
      })
      .finally(() => {
        this.tasks.delete(id);
        this.publish(id);
        const state = this.storage.read(id);
        if (state && ["done", "cancelled"].includes(state.phase)) this.storage.release(id);
        if (more) queueMicrotask(() => this.wake(id));
      });
    this.tasks.set(id, task);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.tasks.values());
    this.listeners.clear();
    this.errors.clear();
    this.storage.close();
  }
}
