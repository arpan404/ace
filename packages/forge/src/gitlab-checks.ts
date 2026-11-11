import type { ForgeRepository } from "@ace/protocol/forge";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { ForgeCheckRun } from "@ace/protocol/forge-checks";
import { GitLabApi, gitLabProjectPath } from "./gitlab-api.ts";
import {
  GitLabJob,
  GitLabJobs,
  GitLabPipeline,
  gitLabJobCheck,
  gitLabPipelineCi,
  pipelineAttempt,
  pipelineFinished,
} from "./gitlab-check-records.ts";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";
import { writesUnder, type HostApiWrite } from "./read-only-api.ts";
import { readJobLog } from "./job-log.ts";

/** Only these writes are handed to SourceControl.writeIdentity. */
/** Retrying and cancelling pipelines and jobs of `repository` only. */
export function gitLabChecksWrites(repository: ForgeRepository): readonly HostApiWrite[] {
  return writesUnder(gitLabProjectPath(repository), [
    { method: "POST", path: "/pipelines/[1-9]\\d*/(retry|cancel)" },
    { method: "POST", path: "/jobs/[1-9]\\d*/retry" },
  ]);
}
const positive = z.number().int().positive();
const logBytes = 1_048_576;

const PipelinePage = z.array(GitLabPipeline).max(100);

/** Pipelines and jobs through the person's own identity-checked glab. No credential access. */
export class GitLabChecks {
  readonly #api: GitLabApi;
  readonly #web: string;
  constructor(api: GitLabApi) {
    this.#api = api;
    const repo = api.repository;
    this.#web = `https://${repo.host}/${repo.owner}/${repo.name}`;
  }

  /** Latest pipeline for the pinned MR head, never an unrelated branch pipeline. */
  async snapshot(number: number, headSha: string, signal: AbortSignal, budget = new ReadBudget()) {
    positive.parse(number);
    const pipelines: z.infer<typeof GitLabPipeline>[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.#api.get(
        `${this.#api.root}/merge_requests/${number}/pipelines?per_page=100&page=${page}`,
        signal,
        budget,
      );
      const parsed = PipelinePage.safeParse(response.body);
      if (!parsed.success) throw new ForgeError("invalid_data");
      pipelines.push(...parsed.data);
      const next = response.headers["x-next-page"];
      if (next?.trim() === "" || (next === undefined && parsed.data.length < 100)) break;
      if (page === 10) throw new ForgeError("limit");
    }
    const pipeline = pipelines
      .filter((item) => item.sha?.toLowerCase() === headSha.toLowerCase())
      .toSorted((a, b) => b.id - a.id)[0];
    if (!pipeline || pipelines.some((item) => item.id > pipeline.id && !item.sha))
      return {
        ci: pipelines.length === 0 ? ("none" as const) : ("unknown" as const),
        checks: [],
        pipelineId: null,
      };
    const jobs = await this.jobs(pipeline.id, signal, budget);
    return {
      ci: gitLabPipelineCi(pipeline.status, jobs),
      checks: jobs.map((job) => gitLabJobCheck(job, this.#web)),
      pipelineId: pipeline.id,
    };
  }

  async jobs(runId: number, signal: AbortSignal, budget = new ReadBudget()): Promise<GitLabJob[]> {
    positive.parse(runId);
    const result: GitLabJob[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await this.#api.get(
        `${this.#api.root}/pipelines/${runId}/jobs?per_page=100&page=${page}&include_retried=false`,
        signal,
        budget,
      );
      const jobs = GitLabJobs.safeParse(response.body);
      if (!jobs.success || jobs.data.some((job) => job.pipeline.id !== runId))
        throw new ForgeError("invalid_data");
      result.push(...jobs.data);
      const next = response.headers["x-next-page"];
      if (next === "" || (next === undefined && jobs.data.length < 100)) return result;
    }
    throw new ForgeError("limit");
  }

  async #pipeline(runId: number, signal: AbortSignal, budget: ReadBudget) {
    positive.parse(runId);
    const response = await this.#api.get(`${this.#api.root}/pipelines/${runId}`, signal, budget);
    const parsed = GitLabPipeline.safeParse(response.body);
    if (!parsed.success || parsed.data.id !== runId) throw new ForgeError("invalid_data");
    return parsed.data;
  }

  async run(checkRunId: number, jobId: number | undefined, signal: AbortSignal) {
    positive.parse(checkRunId);
    if (jobId !== undefined && jobId !== checkRunId) throw new ForgeError("invalid_data");
    const budget = new ReadBudget();
    const response = await this.#api.get(`${this.#api.root}/jobs/${checkRunId}`, signal, budget);
    const parsed = GitLabJob.safeParse(response.body);
    if (!parsed.success || parsed.data.id !== checkRunId) throw new ForgeError("invalid_data");
    const job = parsed.data;
    const jobs = await this.jobs(job.pipeline.id, signal, budget);
    let trace: string | undefined;
    try {
      trace = (await this.#api.text(`${this.#api.root}/jobs/${job.id}/trace`, signal, budget)).body;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ForgeError && error.kind === "not_found")) throw error;
    }
    const bytes = trace === undefined ? undefined : Buffer.from(trace, "utf8");
    const truncated = (bytes?.length ?? 0) > logBytes;
    const tail = bytes ? bytes.subarray(Math.max(0, bytes.length - logBytes)).toString("utf8") : "";
    const check = gitLabJobCheck(job, this.#web);
    return ForgeCheckRun.parse({
      id: job.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: check.url,
      output: { title: null, summary: null, text: null },
      workflow: {
        runId: job.pipeline.id,
        attempt: pipelineAttempt(jobs),
        jobId: job.id,
        steps: [],
      },
      log: trace === undefined ? null : readJobLog(tail, truncated, []).log,
      logUnavailable: trace === undefined,
      annotations: [],
      annotationsTruncated: false,
    });
  }

  async rerunLanded(
    runId: number,
    attempt: number,
    signal: AbortSignal,
    mode: "failed" | "all" = "failed",
  ): Promise<boolean> {
    positive.parse(attempt);
    const jobs = await this.jobs(runId, signal);
    return mode === "all"
      ? jobs.length > 0 && jobs.every((job) => job.id > attempt)
      : pipelineAttempt(jobs) > attempt;
  }
  async runFinished(runId: number, signal: AbortSignal): Promise<boolean> {
    return pipelineFinished((await this.#pipeline(runId, signal, new ReadBudget())).status);
  }

  async #write(
    endpoint: string,
    signal: AbortSignal,
    budget: ReadBudget,
    allowed: () => boolean,
    dispatch: MutationDispatch,
  ) {
    if (!allowed()) throw new ForgeError("cancelled", undefined, false);
    await this.#api.write(endpoint, "POST", {}, signal, budget, dispatch, (body) => body);
  }

  async rerun(
    input: { runId: number; attempt: number; jobs: "failed" | "all" },
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
    positive.parse(input.attempt);
    const budget = new ReadBudget();
    const jobs = await this.jobs(input.runId, signal, budget);
    const attempt = pipelineAttempt(jobs);
    if (attempt > input.attempt) {
      if (input.jobs === "failed" || jobs.every((job) => job.id > input.attempt)) return;
      throw new ForgeMutationOutcome({ partial: true });
    }
    if (attempt !== input.attempt) throw new ForgeError("run_attempt_moved", undefined, false);
    if (input.jobs === "failed") {
      if (!jobs.some((job) => ["failed", "canceled"].includes(job.status))) return;
      await this.#write(
        `${this.#api.root}/pipelines/${input.runId}/retry`,
        signal,
        budget,
        allowed,
        dispatch,
      );
    } else {
      // Retrying active/manual jobs would start work the person never saw finish.
      if (jobs.some((job) => !pipelineFinished(job.status)))
        throw new ForgeError("unsupported", undefined, false);
      for (const job of jobs)
        await this.#write(
          `${this.#api.root}/jobs/${job.id}/retry`,
          signal,
          budget,
          allowed,
          dispatch,
        );
    }
  }

  async cancel(
    input: { runId: number; attempt: number },
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch = new MutationDispatch(),
  ): Promise<void> {
    positive.parse(input.attempt);
    const budget = new ReadBudget();
    const pipeline = await this.#pipeline(input.runId, signal, budget);
    if (pipelineFinished(pipeline.status)) return;
    if (pipelineAttempt(await this.jobs(input.runId, signal, budget)) !== input.attempt)
      throw new ForgeError("run_attempt_moved", undefined, false);
    await this.#write(
      `${this.#api.root}/pipelines/${input.runId}/cancel`,
      signal,
      budget,
      allowed,
      dispatch,
    );
  }
}
