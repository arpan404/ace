import type { AutomationRun } from "@ace/protocol";
import { ExecutionResult, type Dependencies, type ExecutionInput } from "./contracts.ts";
import type { AutomationStore } from "./store.ts";
import { observe } from "./observation.ts";

type Outcome = ExecutionResult | { status: "failed"; result: string };

/**
 * One cancellable monitor per durable run. Cancellation never stops the thread, and a run has no
 * maximum runtime: its status follows the thread tree the executor watches.
 */
export class ExecutionOwner {
  private monitors = new Map<string, AbortController>();
  private pending = new Set<Promise<void>>();
  private deadlines = new Map<string, number>();
  private outcomes = new Map<string, Outcome>();
  private retries = new Map<string, () => void>();
  private wake: () => void;
  private store: AutomationStore;
  private deps: Dependencies;
  private publish: (run: AutomationRun) => void;
  private report: (error: unknown) => void;
  constructor(
    store: AutomationStore,
    deps: Dependencies,
    publish: (run: AutomationRun) => void,
    report: (error: unknown) => void,
    wake: () => void,
  ) {
    this.store = store;
    this.deps = deps;
    this.publish = publish;
    this.report = report;
    this.wake = wake;
  }
  get hasWork(): boolean {
    return this.pending.size > 0;
  }
  launch(run: AutomationRun, input: ExecutionInput): void {
    this.monitor(run, (signal) => this.deps.executor.execute(input, signal));
  }
  restore(run: AutomationRun, input: ExecutionInput): void {
    this.recover(run, input, 0);
  }
  private recover(run: AutomationRun, input: ExecutionInput, attempt: number): void {
    this.monitor(run, async (signal) => {
      let recovered: ExecutionResult | undefined;
      try {
        recovered = await observe(this.deps.executor.recover(input.idempotencyKey, signal), signal);
      } catch (error) {
        if (!signal.aborted) {
          this.report(error);
          this.retryRecovery(run, input, attempt);
        }
        return undefined;
      }
      if (signal.aborted) return undefined;
      return recovered ?? this.deps.executor.execute(input, signal);
    });
  }
  nextDeadline(): number | undefined {
    return this.deadlines.size ? Math.min(...this.deadlines.values()) : undefined;
  }
  /** Retries refused recoveries and terminal writes; a run never expires while its thread works. */
  expire(): void {
    for (const [id, deadline] of this.deadlines) {
      if (this.deps.now() < deadline) continue;
      const outcome = this.outcomes.get(id);
      if (outcome) {
        this.complete(id, outcome);
        continue;
      }
      const retry = this.retries.get(id);
      if (!retry) continue;
      this.retries.delete(id);
      this.deadlines.delete(id);
      this.monitors.get(id)?.abort();
      this.monitors.delete(id);
      retry();
    }
  }
  /** A refused recovery keeps the run and its concurrency, then observes the thread again. */
  private retryRecovery(run: AutomationRun, input: ExecutionInput, attempt: number): void {
    if (this.outcomes.has(run.id)) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
    this.deadlines.set(run.id, this.deps.now() + delay);
    this.retries.set(run.id, () => this.recover(run, input, attempt + 1));
    this.wake();
  }
  stop(): void {
    const monitors = [...this.monitors.values()];
    this.monitors.clear();
    this.deadlines.clear();
    this.outcomes.clear();
    this.retries.clear();
    this.pending.clear();
    for (const controller of monitors) controller.abort();
  }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }
  private complete(id: string, outcome: Outcome): void {
    const controller = this.monitors.get(id);
    if (!controller) return;
    this.outcomes.set(id, outcome);
    controller.abort();
    if (this.monitors.get(id) !== controller) return;
    let finished: AutomationRun | undefined;
    try {
      finished = this.store.finish(id, this.deps.now(), outcome);
    } catch (error) {
      // Retain the exact outcome and bounded ownership until SQLite accepts it.
      this.deadlines.set(id, this.deps.now() + 1000);
      this.report(error);
      this.wake();
      return;
    }
    if (this.monitors.get(id) !== controller) return;
    this.monitors.delete(id);
    this.deadlines.delete(id);
    this.outcomes.delete(id);
    this.retries.delete(id);
    if (finished) this.publish(finished);
  }
  private monitor(
    run: AutomationRun,
    execute: (signal: AbortSignal) => Promise<ExecutionResult | undefined>,
  ): void {
    if (this.monitors.has(run.id)) return;
    if (this.monitors.size >= 256) throw new Error("Execution monitor limit reached");
    const controller = new AbortController();
    this.monitors.set(run.id, controller);
    let request: Promise<ExecutionResult | undefined>;
    try {
      request = Promise.resolve(execute(controller.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    const operation = async () => {
      try {
        const result = await observe(request, controller.signal);
        if (result !== undefined && !controller.signal.aborted) {
          const outcome = ExecutionResult.parse(result);
          this.complete(run.id, outcome);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.complete(run.id, {
            status: "failed",
            result: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
          });
        }
      }
    };
    const tracked = operation().finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}
