import { z } from "zod";
import { ForgeCheck, type ForgePrStatus } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";

const positive = z.number().int().positive();
export const GitLabPipeline = z.looseObject({
  id: positive,
  status: z.string(),
  sha: z.string().optional(),
});
export const GitLabJob = z.looseObject({
  id: positive,
  name: z.string(),
  status: z.string(),
  pipeline: GitLabPipeline,
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  allow_failure: z.boolean().optional(),
});
export const GitLabJobs = z.array(GitLabJob).max(100);
export type GitLabJob = z.infer<typeof GitLabJob>;
/** GitLab's job and pipeline states that are still under way: never passed, never final. */
const underWay = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "blocked",
  "scheduled",
  "canceling",
];

/**
 * What one job means for the merge, as GitLab counts it (docs.gitlab.com/ci/yaml/#allow_failure,
 * #when): a skipped job, a manual job that may fail, and a failure that is allowed are neutral
 * (never blocking, never passed); a manual job that may not fail waits.
 */
type JobVerdict = "success" | "failure" | "pending" | "neutral" | "unknown";
function jobVerdict(status: string, allowFailure: boolean): JobVerdict {
  if (status === "success") return "success";
  if (status === "skipped") return "neutral";
  if (status === "manual") return allowFailure ? "neutral" : "pending";
  if (status === "failed") return allowFailure ? "neutral" : "failure";
  if (status === "canceled") return "failure";
  if (underWay.includes(status)) return "pending";
  return "unknown";
}

/** A job as a check: a neutral job is shown settled without counting as passed or failed. */
export function gitLabCheckStatus(status: string, allowFailure = false): ForgeCheck["status"] {
  if (status === "canceled") return "cancelled";
  const verdict = jobVerdict(status, allowFailure);
  return verdict === "neutral" ? "cancelled" : verdict;
}

/**
 * A pipeline's own status as CI. A skipped pipeline, or one whose only remaining jobs are manual,
 * says nothing on its own (`none`); canceled is a failure, as GitLab won't merge it.
 */
export function gitLabCi(status: string): ForgePrStatus["ci"] {
  if (status === "skipped" || status === "manual") return "none";
  const verdict = jobVerdict(status, false);
  return verdict === "neutral" ? "none" : verdict;
}
export function gitLabJobCheck(job: GitLabJob, webRoot: string): ForgeCheck {
  return ForgeCheck.parse({
    id: `check:${job.id}`,
    name: clipText(job.name),
    status: gitLabCheckStatus(job.status, job.allow_failure === true),
    // A failure GitLab allows reads as a warning, as GitLab shows it.
    conclusion:
      job.status === "failed" && job.allow_failure === true ? "warning" : job.status.slice(0, 256),
    completedAt: job.finished_at ?? null,
    startedAt: job.started_at ?? null,
    jobId: job.id,
    url: `${webRoot}/-/jobs/${job.id}`,
  });
}
export function pipelineAttempt(jobs: readonly GitLabJob[]): number {
  if (!jobs.length) throw new ForgeError("unsupported");
  return Math.max(...jobs.map((job) => job.id));
}
export function pipelineFinished(status: string): boolean {
  return ["success", "failed", "canceled", "skipped"].includes(status);
}

/**
 * The pipeline's CI from its status and its jobs. Any failing job fails it, any job under way
 * (or a manual job that must run) keeps it pending, and success needs at least one passed job;
 * neutral jobs neither pass nor block. Unknown states and a pipeline with no jobs are unknown.
 */
export function gitLabPipelineCi(status: string, jobs: readonly GitLabJob[]): ForgePrStatus["ci"] {
  const verdicts = jobs.map((job) => jobVerdict(job.status, job.allow_failure === true));
  const states = new Set<JobVerdict | "none">([gitLabCi(status), ...verdicts]);
  if (states.has("failure")) return "failure";
  if (states.has("pending")) return "pending";
  if (states.has("unknown") || !jobs.length) return "unknown";
  // The pipeline's own success never stands in for its jobs'.
  return verdicts.includes("success") ? "success" : "none";
}
