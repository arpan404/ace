import type { AutomationRun } from "@ace/protocol";
import { ExecutionResult, type Dependencies, type ExecutionInput } from "./contracts.ts";
import type { AutomationStore } from "./store.ts";
import { observe } from "./observation.ts";

type Outcome = ExecutionResult | { status: "failed"; result: string };

/** One cancellable monitor per durable run. Cancellation never stops the thread. */
export class ExecutionOwner {
  private monitors = new Map<string, AbortController>();
  private pending = new Set<Promise<void>>();
  private deadlines = new Map<string, number>();
  private outcomes = new Map<string, Outcome>();
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
    this.monitor(run, async (signal) => {
      let recovered: ExecutionResult | undefined;
      try {
        recovered = await observe(this.deps.executor.recover(input.idempotencyKey, signal), signal);
      } catch (error) {
        if (!signal.aborted) this.report(error);
        return undefined;
      }
      if (signal.aborted) return undefined;
      if (this.deps.now() >= run.startedAt + (this.deps.maxRunMs ?? 3_600_000)) {
        this.expire();
        return undefined;
      }
      return recovered ?? this.deps.executor.execute(input, signal);
    });
  }
  nextDeadline(): number | undefined {
    return this.deadlines.size ? Math.min(...this.deadlines.values()) : undefined;
  }
  expire(): void {
    for (const [id, deadline] of this.deadlines) {
      if (this.deps.now() < deadline) continue;
      this.complete(
        id,
        this.outcomes.get(id) ?? {
          status: "failed",
          result: "Automation exceeded its maximum runtime",
        },
      );
    }
  }
  stop(): void {
    const monitors = [...this.monitors.values()];
    this.monitors.clear();
    this.deadlines.clear();
    this.outcomes.clear();
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
    if (finished) this.publish(finished);
  }
  private monitor(
    run: AutomationRun,
    execute: (signal: AbortSignal) => Promise<ExecutionResult | undefined>,
  ): void {
    if (this.monitors.has(run.id)) return;
    const deadline = run.startedAt + (this.deps.maxRunMs ?? 3_600_000);
    if (this.monitors.size >= 256) throw new Error("Execution monitor limit reached");
    const controller = new AbortController();
    this.monitors.set(run.id, controller);
    this.deadlines.set(run.id, deadline);
    if (this.deps.now() >= deadline) {
      this.expire();
      return;
    }
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
