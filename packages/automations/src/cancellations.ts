import type { AutomationRun } from "@ace/protocol";
import type { Dependencies, ExecutionInput } from "./contracts.ts";
import type { AutomationStore } from "./store.ts";

/**
 * Carries out the cancellations a pause or delete stores with it (`AutomationStore.halt`): each
 * cancelled run's stop is handed to the executor, which keeps it durably and follows it through.
 * A failed hand-off is retried with backoff while the cancellation stands, and start-up hands
 * every standing one over again, so a crash in between never leaves the run going.
 */
export class Cancellations {
  private store: AutomationStore;
  private deps: Dependencies;
  private live: () => boolean;
  private report: (error: unknown) => void;
  private track: (operation: Promise<void>) => void;
  private retries = new Set<() => void>();
  private generation = 0;
  constructor(
    store: AutomationStore,
    deps: Dependencies,
    live: () => boolean,
    report: (error: unknown) => void,
    track: (operation: Promise<void>) => void,
  ) {
    this.store = store;
    this.deps = deps;
    this.live = live;
    this.report = report;
    this.track = track;
  }
  /** Hand over every standing cancellation, or only `automationId`'s. */
  carryOut(automationId?: string): void {
    try {
      for (const { run, input } of this.store.cancelling())
        if (automationId === undefined || run.automationId === automationId)
          this.cancel(run, input, 0);
    } catch (error) {
      this.report(error);
    }
  }
  stop(): void {
    this.generation++;
    for (const cancelRetry of this.retries) cancelRetry();
    this.retries.clear();
  }
  private cancel(run: AutomationRun, input: ExecutionInput, attempt: number): void {
    const interrupt = this.deps.executor.interrupt?.bind(this.deps.executor);
    if (!interrupt || !this.live()) return;
    const generation = this.generation;
    this.track(
      interrupt(input).catch((error: unknown) => {
        this.report(error);
        if (!this.live() || generation !== this.generation) return;
        if (this.store.cancellation(run.id) === undefined) return;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
        const cancelRetry = this.deps.timer.arm(delay, () => {
          this.retries.delete(cancelRetry);
          if (this.live() && generation === this.generation) this.cancel(run, input, attempt + 1);
        });
        this.retries.add(cancelRetry);
      }),
    );
  }
}
