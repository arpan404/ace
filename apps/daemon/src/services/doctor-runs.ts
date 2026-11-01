import type { DiagnosticRepair, DiagnosticReport, DiagnosticsRun } from "@ace/protocol";

type Operation = "doctor" | "fix";

export interface DoctorOutcome {
  report: DiagnosticReport;
  repairs?: DiagnosticRepair[] | undefined;
}

/**
 * The daemon's one checks run at a time (Run checks or Run safe repairs), shared by every socket.
 * A request for the run already going joins it instead of failing busy, a socket that closes
 * doesn't end it, and the last outcome stays readable so an app that comes back (another tab, a
 * reconnect) can show it. Health reads never wait on it.
 */
export class DoctorRuns {
  readonly #now: () => number;
  #run: Exclude<DiagnosticsRun, { state: "running" }> = { state: "idle" };
  #running: { operation: Operation; startedAt: number } | undefined;
  #pending: { operation: Operation; outcome: Promise<DoctorOutcome> } | undefined;

  constructor(now: () => number) {
    this.#now = now;
  }

  status(): DiagnosticsRun {
    if (!this.#running) return this.#run;
    const { operation, startedAt } = this.#running;
    return {
      state: "running",
      operation,
      startedAt,
      elapsedMs: Math.max(0, this.#now() - startedAt),
    };
  }

  /** Start `operation`, or join it when it is already running; undefined while the other runs. */
  run(
    operation: Operation,
    task: () => Promise<DoctorOutcome>,
  ): Promise<DoctorOutcome> | undefined {
    if (this.#pending)
      return this.#pending.operation === operation ? this.#pending.outcome : undefined;
    const startedAt = this.#now();
    this.#running = { operation, startedAt };
    const outcome = Promise.resolve()
      .then(task)
      .then(
        (result) => {
          this.#run = {
            state: "done",
            operation,
            startedAt,
            finishedAt: this.#now(),
            report: result.report,
            ...(result.repairs ? { repairs: result.repairs } : {}),
          };
          return result;
        },
        (error: unknown) => {
          this.#run = { state: "failed", operation, startedAt, finishedAt: this.#now() };
          throw error;
        },
      )
      .finally(() => {
        this.#pending = undefined;
        this.#running = undefined;
      });
    this.#pending = { operation, outcome };
    return outcome;
  }
}
