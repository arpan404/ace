import { isMutationUnavailable } from "@ace/git";
import {
  StartSpec,
  ConductorStore,
  ConductorDriver,
  type Executor,
  type Environment,
  type Fact,
  type Account,
  type State,
} from "@ace/conductor";
import {
  ConductorRunView,
  ConductorCommandPayload,
  type CommandResult,
  type Command,
  type ConductorSpec,
  ConductorApproval,
} from "@ace/protocol";
import type { Store } from "./store.ts";
export interface ConductorRuntimeOptions {
  execute?: Executor;
  validateStart?(spec: ConductorSpec): string | undefined;
  accounts?(spec?: ConductorSpec, run?: string): readonly Account[];
  decorate?(view: ConductorRunView): ConductorRunView;
  changed?(run: string): void;
  autostart?: boolean;
  observations?(): Promise<void>;
  onError?(error: unknown): void;
}
export class ConductorRuntime {
  private storage: ConductorStore;
  private driver: ConductorDriver;
  private receipts: Store;
  private options: ConductorRuntimeOptions;
  private env: Environment;
  private listeners = new Map<string, Set<(view: ConductorRunView) => void>>();
  private tasks = new Map<string, Promise<void>>();
  private queued = new Set<string>();
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
    if (options.autostart !== false) this.start();
  }
  start(): void {
    if (this.options.execute) for (const run of this.storage.resumable()) this.wake(run);
  }
  active(): string[] {
    return this.storage.resumable();
  }
  state(id: string): State | null {
    return this.storage.read(id);
  }
  approveInteraction(
    id: string,
    receipt: string,
    approval: import("zod").infer<typeof ConductorApproval>,
  ): void {
    this.fact(id, receipt, { type: "approve", approval });
  }
  retry(id: string): void {
    this.wake(id);
  }
  refresh(id: string): void {
    this.publish(id);
    this.wake(id);
  }
  get(id: string): ConductorRunView | undefined {
    const view = this.storage.view(id);
    if (!view) return undefined;
    return ConductorRunView.parse({
      ...(this.options.decorate?.(view) ?? view),
      ...(this.errors.has(id) ? { executionError: this.errors.get(id) } : {}),
    });
  }

  list(after: string | undefined, limit: number, active?: boolean) {
    const page = this.storage.list(after, limit, active);
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
  observe(id: string, fact: Fact): void {
    this.storage.observe(id, fact, this.env);
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
        if (payload.type === "conductor.start") {
          const validated = StartSpec.safeParse(payload.spec);
          if (!validated.success)
            return { commandId: command.id, ok: false, error: "conductor_invalid_root_agent" };
          // Replays of an admitted run do not re-check transient availability.
          if (!this.storage.read(payload.runId)) {
            const error = this.options.validateStart?.(validated.data);
            if (error) return { commandId: command.id, ok: false, error };
          }
          this.storage.create(
            payload.runId,
            validated.data,
            this.env,
            this.options.accounts?.(validated.data, payload.runId),
          );
        } else this.driver.command(command.id, payload);
        return { commandId: command.id, ok: true };
      } catch {
        return { commandId: command.id, ok: false, error: "conductor_command_failed" };
      }
    });
    if (result.ok) {
      this.options.changed?.(payload.runId);
      this.publish(payload.runId);
      this.wake(payload.runId);
    }
    return result;
  }
  private wake(id: string): void {
    if (this.closing || !this.options.execute) return;
    if (this.tasks.has(id) || this.tasks.size >= 8) {
      this.queued.add(id);
      return;
    }
    const driver = new ConductorDriver(this.storage, this.options.execute, this.env);
    if (!driver.ready(id)) return;
    let processed = false;
    let errorChanged = false;
    const failed = (error: unknown) => {
      try {
        this.options.onError?.(error);
      } catch {
        /* Reporting cannot stop independent intents. */
      }
      if (this.errors.size >= 64) {
        const oldest = this.errors.keys().next().value;
        if (oldest) this.errors.delete(oldest);
      }
      const message = isMutationUnavailable(error)
        ? "git_quarantined"
        : error instanceof Error && /^deck_[a-z_]+$/.test(error.message)
          ? error.message
          : "conductor_execution_failed";
      errorChanged = errorChanged || this.errors.get(id) !== message;
      this.errors.set(id, message);
    };
    const task = driver
      .drain(id, 128, failed)
      .then((count) => {
        processed = count > 0;
        if (!this.storage.hasFailures(id)) errorChanged = this.errors.delete(id) || errorChanged;
      })
      .catch(failed)
      .finally(() => {
        this.tasks.delete(id);
        if (processed || errorChanged) this.publish(id);
        if (processed) this.options.changed?.(id);
        const state = this.storage.read(id);
        if (state && ["done", "cancelled"].includes(state.phase)) this.storage.release(id);
        // A fact can arrive after drain's final queue read but before this release.
        if (!this.closing && driver.ready(id)) this.queued.add(id);
        const queued = [...this.queued];
        this.queued.clear();
        for (const run of queued) this.wake(run);
      });
    this.tasks.set(id, task);
  }
  /** Wait for admitted effects and observations, without advancing clocks. */
  async flush(): Promise<void> {
    do {
      await Promise.allSettled(this.tasks.values());
      await this.options.observations?.();
    } while (this.tasks.size);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.queued.clear();
    await Promise.allSettled(this.tasks.values());
    this.listeners.clear();
    this.errors.clear();
    this.storage.close();
  }
}
