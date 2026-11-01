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
  readonly #id: () => string;
  #run: Exclude<DiagnosticsRun, { state: "running" }> = { state: "idle" };
  #pending:
    | { id: string; operation: Operation; startedAt: number; outcome: Promise<DoctorOutcome> }
    | undefined;
  /** The last run's outcome, for a join that arrives after it ended. */
  #last: { id: string; outcome: Promise<DoctorOutcome> } | undefined;

  constructor(now: () => number, id: () => string) {
    this.#now = now;
    this.#id = id;
  }

  status(): DiagnosticsRun {
    if (!this.#pending) return this.#run;
    const { id, operation, startedAt } = this.#pending;
    return {
      state: "running",
      id,
      operation,
      startedAt,
      elapsedMs: Math.max(0, this.#now() - startedAt),
    };
  }

  /**
   * The outcome of run `id`: the one going, or the last one if it has ended. Undefined when that
   * run is gone (an older run, or one from before a restart). Never starts work.
   */
  join(id: string): Promise<DoctorOutcome> | undefined {
    if (this.#pending?.id === id) return this.#pending.outcome;
    return this.#last?.id === id ? this.#last.outcome : undefined;
  }

  /** Start `operation`, or join it when it is already running; undefined while the other runs. */
  run(
    operation: Operation,
    task: () => Promise<DoctorOutcome>,
  ): Promise<DoctorOutcome> | undefined {
    if (this.#pending)
      return this.#pending.operation === operation ? this.#pending.outcome : undefined;
    const startedAt = this.#now();
    const id = this.#id();
    const outcome = Promise.resolve()
      .then(task)
      .then(
        (result) => {
          this.#run = {
            state: "done",
            id,
            operation,
            startedAt,
            finishedAt: this.#now(),
            report: result.report,
            ...(result.repairs ? { repairs: result.repairs } : {}),
          };
          return result;
        },
        (error: unknown) => {
          this.#run = { state: "failed", id, operation, startedAt, finishedAt: this.#now() };
          throw error;
        },
      )
      .finally(() => {
        this.#pending = undefined;
      });
    // A settled outcome nobody joins later mustn't read as an unhandled failure.
    outcome.catch(() => {});
    this.#pending = { id, operation, startedAt, outcome };
    this.#last = { id, outcome };
    return outcome;
  }
}
