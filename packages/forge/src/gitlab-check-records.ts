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
});
export const GitLabJobs = z.array(GitLabJob).max(100);
export type GitLabJob = z.infer<typeof GitLabJob>;
export function gitLabCheckStatus(status: string): ForgeCheck["status"] {
  if (status === "success") return "success";
  if (status === "skipped") return "cancelled";
  if (status === "failed") return "failure";
  if (status === "canceled") return "cancelled";
  if (
    [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "running",
      "manual",
      "blocked",
      "scheduled",
      "canceling",
    ].includes(status)
  )
    return "pending";
  return "unknown";
}
export function gitLabCi(status: string): ForgePrStatus["ci"] {
  const mapped = gitLabCheckStatus(status);
  return mapped === "cancelled" ? "failure" : mapped;
}
export function gitLabJobCheck(job: GitLabJob, webRoot: string): ForgeCheck {
  return ForgeCheck.parse({
    id: `check:${job.id}`,
    name: clipText(job.name),
    status: gitLabCheckStatus(job.status),
    conclusion: job.status.slice(0, 256),
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

/** Every source must agree on success. Incomplete or waiting jobs never become passed. */
export function gitLabPipelineCi(status: string, jobs: readonly GitLabJob[]): ForgePrStatus["ci"] {
  const states = new Set([gitLabCi(status), ...jobs.map((job) => gitLabCi(job.status))]);
  if (states.has("failure")) return "failure";
  if (states.has("pending")) return "pending";
  if (states.has("unknown") || !jobs.length) return "unknown";
  return "success";
}
