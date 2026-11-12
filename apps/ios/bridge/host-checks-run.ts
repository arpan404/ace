import type { ClientCore } from "@ace/client";
import type { DiagnosticReport, DiagnosticsRun } from "@ace/protocol";
import {
  checkStatusWords,
  checksRunning,
  checksRunWords,
  hostChecks,
  unknownCheck,
} from "@ace/ui-core/host-care";
import { host } from "./host.ts";
import { HostProblem } from "./host-problem.ts";

/*
 * The machine's checks run on the phone's Diagnostics page, as the web's Run checks: the run
 * lives on the daemon and outlives the page. Starting answers as soon as the run is going; the
 * page reads the run with its status and, while it runs, waits on it by its id (`join`), which
 * never starts work. Leaving and coming back finds the same run, or its report once it ended.
 */

/** Longer than the daemon's largest integrity budget, so the daemon reports first. */
const checksTimeoutMs = 16 * 60_000;

export interface HostCheckRow {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  word: string;
  message: string;
  /** What to do, for a check that didn't pass. */
  fix: string | null;
}

/** The checks run as the page draws it. */
export interface HostChecksView {
  type: "host.checks";
  /** A run that failed reads as idle, as on the web: nothing to show but Run checks. */
  state: "idle" | "running" | "done";
  /** The run to wait on (`host.checks.join`) or whose report shows; null when it isn't known. */
  runId: string | null;
  /** When a running run started, by this phone's clock (ms since 1970), for counting its time. */
  startedAt: number | null;
  /** The words around the running time: "Checking for" 12s, then the note. */
  lead: string;
  note: string;
  summary: string;
  rows: HostCheckRow[];
}

/** The setup checks as rows, without the provider checks Providers already shows. */
export function checkRows(report: DiagnosticReport): HostCheckRow[] {
  return report.checks
    .filter((check) => !check.id.startsWith("provider."))
    .map((check) => {
      const info = hostChecks[check.id] ?? unknownCheck;
      return {
        id: check.id,
        label: info.label,
        status: check.status,
        word: checkStatusWords[check.status],
        message: check.message,
        fix: check.status === "ok" ? null : info.fix,
      };
    });
}

/** One line over the checks: all passed, or how many need something. */
export function checksSummary(rows: readonly HostCheckRow[]): string {
  const failing = rows.filter((row) => row.status !== "ok").length;
  if (!failing) return "Every check passed.";
  return failing === 1 ? "1 check needs attention." : `${failing} checks need attention.`;
}

const idle: HostChecksView = {
  type: "host.checks",
  state: "idle",
  runId: null,
  startedAt: null,
  lead: "",
  note: "",
  summary: "",
  rows: [],
};

function finished(report: DiagnosticReport, runId: string | null): HostChecksView {
  const rows = checkRows(report);
  return { ...idle, state: "done", runId, summary: checksSummary(rows), rows };
}

/** The daemon's run as the page draws it; `now` is this phone's clock. */
export function checksView(run: DiagnosticsRun, now: number): HostChecksView {
  if (run.state === "done") return finished(run.report, run.id);
  if (run.state !== "running") return idle;
  // The daemon's clock may differ from the phone's: count from how long it has run.
  return {
    ...idle,
    state: "running",
    runId: run.id,
    startedAt: now - run.elapsedMs,
    ...checksRunning(run.operation),
  };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export class HostChecksRun {
  #owner: ClientCore;
  constructor(owner: ClientCore) {
    this.#owner = owner;
  }

  /** The run as it is now; undefined from a daemon that can't report it. */
  async status(signal: AbortSignal): Promise<HostChecksView | undefined> {
    const run = await this.#run(signal);
    return run && checksView(run, host.now());
  }
  async #run(signal: AbortSignal): Promise<DiagnosticsRun | undefined> {
    const reply = await this.#owner.request(
      { type: "diagnostics.request", operation: "status", requestId: host.uuid() },
      { signal, timeoutMs: 10_000 },
    );
    return reply.run;
  }

  /**
   * Start checks. The request isn't tied to the page: the run goes on when the person leaves.
   * A run that is going answers at once, to be joined; a daemon that can't report its run is
   * waited on, as before.
   */
  async start(signal: AbortSignal): Promise<HostChecksView> {
    const reply = this.#owner.request(
      { type: "diagnostics.request", operation: "doctor", requestId: host.uuid() },
      { timeoutMs: checksTimeoutMs },
    );
    // Observed below, or ended by the run while nobody waits on it.
    reply.catch(() => {});
    const run = await this.#run(signal).catch(() => undefined);
    if (run?.state === "running") {
      // Repairs started elsewhere hold the run; checks wait for them.
      if (run.operation !== "doctor") throw new HostProblem(checksRunWords.busy);
      return checksView(run, host.now());
    }
    const result = await abortable(reply, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new HostProblem(checksRunWords.failed);
    });
    if (result.error === "diagnostics_busy") throw new HostProblem(checksRunWords.busy);
    if (!result.report || result.error) throw new HostProblem(checksRunWords.failed);
    return finished(result.report, null);
  }

  /** Wait for the run `runId` names to end; one that is gone reads the run as it is now. */
  async join(runId: string, signal: AbortSignal): Promise<HostChecksView> {
    const reply = await this.#owner.request(
      { type: "diagnostics.request", operation: "join", runId, requestId: host.uuid() },
      { signal, timeoutMs: checksTimeoutMs },
    );
    if (reply.error === "diagnostics_run_gone") return (await this.status(signal)) ?? idle;
    if (!reply.report || reply.error) throw new HostProblem(checksRunWords.failed);
    return finished(reply.report, runId);
  }
}
