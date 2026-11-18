/**
 * The one message the owner gets when a release run ends (ADR 0188): the release went live, or
 * the first step that failed. Pure: the jobs' results in pipeline order go in.
 */

export type JobResult = "success" | "failure" | "cancelled" | "skipped";

export interface JobOutcome {
  /** The job's id in the workflow, e.g. `build-mac`. */
  job: string;
  result: JobResult;
}

export interface ReleaseSummary {
  ok: boolean;
  title: string;
  body: string;
}

/** `jobs` in pipeline order; `url` is the run's page. */
export function releaseSummary(input: {
  tag: string;
  jobs: readonly JobOutcome[];
  url: string;
}): ReleaseSummary {
  const failed = input.jobs.find((job) => job.result === "failure" || job.result === "cancelled");
  const published = input.jobs.find((job) => job.job === "publish")?.result === "success";
  if (failed)
    return {
      ok: false,
      title: `${input.tag} stopped at ${failed.job}`,
      body: `${failed.job} ${failed.result === "cancelled" ? "was cancelled" : "failed"}. Fix it and rerun the failed jobs; finished steps are kept. ${input.url}`,
    };
  if (!published)
    return {
      ok: false,
      title: `${input.tag} didn't publish`,
      body: `No step failed, but publish didn't run. ${input.url}`,
    };
  return { ok: true, title: `${input.tag} is live`, body: `Every step passed. ${input.url}` };
}
