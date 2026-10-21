import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import {
  ForgeCheckRun,
  type ForgeCheckAnnotation,
  type ForgeCheckStep,
} from "@ace/protocol/forge-checks";
import { ForgeError } from "./errors.ts";
import type { GhApi } from "./http.ts";
import { immutable } from "./immutable.ts";
import { readJobLog, type JobStepFacts } from "./job-log.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { mapCheck } from "./status.ts";

/** The newest part of a job log kept for the panel. Most logs are far smaller. */
const logBytes = 1_048_576;
/** Finished check runs kept for reopening; a check run's id names one attempt. */
const keptRuns = 32;
const str = z.string().max(65_536);
const positive = z.number().int().positive();
const CheckRunBody = z.looseObject({
  id: positive,
  output: z
    .looseObject({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const JobBody = z.looseObject({
  id: positive,
  run_id: positive,
  run_attempt: positive.optional(),
  steps: z
    .array(
      z.looseObject({
        number: z.number().int().nonnegative(),
        name: str,
        status: str,
        conclusion: str.nullable().optional(),
        started_at: str.nullable().optional(),
      }),
    )
    .max(1_000)
    .optional(),
});
const AnnotationsBody = z
  .array(
    z.looseObject({
      path: str,
      start_line: z.number().int().nullable().optional(),
      end_line: z.number().int().nullable().optional(),
      annotation_level: str.nullable().optional(),
      title: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
    }),
  )
  .max(100);
const RunBody = z.looseObject({ id: positive, run_attempt: positive });

const clip = (value: string | null | undefined) => (value ? value.slice(0, 65_536) : null);
const lineNumber = (value: number | null | undefined) =>
  value !== null && value !== undefined && value > 0 ? value : null;

function stepStatus(
  status: string,
  conclusion: string | null | undefined,
): ForgeCheckStep["status"] {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral") return "success";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "cancelled") return "cancelled";
  if (conclusion === "failure" || conclusion === "timed_out") return "failure";
  return "unknown";
}

function annotationLevel(level: string | null | undefined): ForgeCheckAnnotation["level"] {
  return level === "failure" || level === "warning" ? level : "notice";
}

/** Check runs read on demand and the Actions re-runs behind them. */
export class GitHubChecks {
  readonly #api: GhApi;
  readonly #root: string;
  readonly #kept = new Map<number, ForgeCheckRun>();
  constructor(api: GhApi, repository: ForgeRepository) {
    this.#api = api;
    this.#root = `repos/${repository.owner}/${repository.name}`;
  }

  /**
   * One check run with everything the panel shows for it, read in parallel: the run, its
   * annotations and, for an Actions job, the job's steps and log. A finished run is kept.
   */
  async run(checkRunId: number, jobId: number | undefined, signal: AbortSignal) {
    positive.parse(checkRunId);
    if (jobId !== undefined) positive.parse(jobId);
    const kept = this.#kept.get(checkRunId);
    if (kept) {
      this.#kept.delete(checkRunId);
      this.#kept.set(checkRunId, kept);
      return kept;
    }
    const root = this.#root;
    const annotationsPath = `${root}/check-runs/${checkRunId}/annotations?per_page=100`;
    // Every read settles before any failure is thrown, so no gh process outlives the call.
    const [checkRead, annotationsRead, jobRead, logRead] = await Promise.allSettled([
      this.#api.request(`${root}/check-runs/${checkRunId}`, signal),
      this.#api.request(annotationsPath, signal),
      jobId === undefined ? undefined : this.#api.request(`${root}/actions/jobs/${jobId}`, signal),
      jobId === undefined
        ? undefined
        : this.#api.log(`${root}/actions/jobs/${jobId}/logs`, signal, logBytes),
    ]);
    if (checkRead.status === "rejected") throw checkRead.reason;
    if (annotationsRead.status === "rejected") throw annotationsRead.reason;
    signal.throwIfAborted();
    const check = mapCheck(checkRead.value.body);
    const body = CheckRunBody.safeParse(checkRead.value.body);
    const annotations = AnnotationsBody.safeParse(annotationsRead.value.body);
    if (!body.success || !annotations.success || body.data.id !== checkRunId)
      throw new ForgeError("invalid_data");
    // A job id that names no Actions job (an external app's link) reads as no workflow.
    if (jobRead.status === "rejected") {
      const error = jobRead.reason;
      if (!(error instanceof ForgeError && error.kind === "not_found")) throw error;
    }
    const job =
      jobRead.status === "fulfilled" && jobRead.value
        ? JobBody.safeParse(jobRead.value.body)
        : undefined;
    if (job && !job.success) throw new ForgeError("invalid_data");
    const facts: JobStepFacts[] = (job?.data.steps ?? []).map((step) => {
      const at = step.started_at ? Date.parse(step.started_at) : NaN;
      return {
        number: step.number,
        name: step.name,
        status: stepStatus(step.status, step.conclusion),
        startedAt: Number.isFinite(at) ? Math.floor(at / 1_000) : null,
      };
    });
    const logText = logRead.status === "fulfilled" ? logRead.value : undefined;
    // With no log, the steps still read; none has a line to start at.
    const read = readJobLog(logText?.text ?? "", logText?.truncated ?? false, facts);
    const output = body.data.output;
    const value = ForgeCheckRun.parse({
      id: checkRunId,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.url,
      output: {
        title: clip(output?.title),
        summary: clip(output?.summary),
        text: clip(output?.text),
      },
      workflow: job?.data
        ? {
            runId: job.data.run_id,
            attempt: job.data.run_attempt ?? 1,
            jobId: job.data.id,
            steps: read.steps,
          }
        : null,
      log: logText ? read.log : null,
      logUnavailable: job?.data !== undefined && !logText,
      annotations: annotations.data.map((annotation) => ({
        path: annotation.path,
        startLine: lineNumber(annotation.start_line),
        endLine: lineNumber(annotation.end_line),
        level: annotationLevel(annotation.annotation_level),
        title: clip(annotation.title) ?? "",
        message: clip(annotation.message) ?? "",
      })),
      annotationsTruncated: this.#api.next(annotationsRead.value, annotationsPath) !== undefined,
    });
    const result = immutable(value);
    // A running check's log and steps still change; only a finished, fully read one is kept.
    if (check.status !== "pending" && !result.logUnavailable) this.#keep(checkRunId, result);
    return result;
  }

  #keep(id: number, value: ForgeCheckRun): void {
    this.#kept.set(id, value);
    while (this.#kept.size > keptRuns) {
      const oldest = this.#kept.keys().next().value;
      if (oldest === undefined) break;
      this.#kept.delete(oldest);
    }
  }

  /** Whether the workflow run has moved past `attempt`: a re-run of it was accepted. */
  async rerunLanded(runId: number, attempt: number, signal: AbortSignal): Promise<boolean> {
    const response = await this.#api.request(`${this.#root}/actions/runs/${runId}`, signal);
    const run = RunBody.safeParse(response.body);
    if (!run.success || run.data.id !== runId) throw new ForgeError("invalid_data");
    return run.data.run_attempt > attempt;
  }

  /**
   * Re-run the workflow run's failed jobs, or all of them. A run already past `attempt` was
   * re-run (by an earlier try whose result was lost, or by someone else) and isn't again.
   */
  async rerun(
    input: { runId: number; attempt: number; jobs: "failed" | "all" },
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
    positive.parse(input.runId);
    positive.parse(input.attempt);
    if (await this.rerunLanded(input.runId, input.attempt, signal)) return;
    if (!allowed()) throw new ForgeError("cancelled", undefined, false);
    const action = input.jobs === "failed" ? "rerun-failed-jobs" : "rerun";
    const response = await this.#api.request(
      `${this.#root}/actions/runs/${input.runId}/${action}`,
      signal,
      {},
      "POST",
      dispatch,
    );
    if (response.identityChanged) throw new ForgeMutationOutcome(response.body);
  }
}
