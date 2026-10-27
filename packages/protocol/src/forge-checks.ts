import { z } from "zod";
import { ForgeCheck, ForgePrRef, ForgeRepository } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

/*
 * One check run read on demand, when the PR panel opens it: its job log, steps, annotations
 * and summary, and the re-runs and cancels a GitHub Actions workflow run takes.
 */

const text = z.string().max(65_536);
const positive = z.number().int().positive();
const line = z.number().int().nonnegative();
/** The longest log text a check run carries: the newest part of a longer log. */
export const maxCheckLogLength = 2_097_152;

export const ForgeCheckStep = z.object({
  number: z.number().int().nonnegative(),
  name: text,
  status: z.enum(["pending", "success", "failure", "cancelled", "skipped", "unknown"]),
  /** The log line this step starts at, when the log shows it. */
  line: line.nullable(),
});
export type ForgeCheckStep = z.infer<typeof ForgeCheckStep>;

export const ForgeCheckAnnotation = z.object({
  path: text,
  startLine: positive.nullable(),
  endLine: positive.nullable(),
  level: z.enum(["notice", "warning", "failure"]),
  title: text,
  message: text,
});
export type ForgeCheckAnnotation = z.infer<typeof ForgeCheckAnnotation>;

export const ForgeCheckLog = z.object({
  /** Lines without the runner's timestamps and workflow-command markers. */
  text: z.string().max(maxCheckLogLength),
  /** Older lines were dropped to keep the newest part of a longer log. */
  truncated: z.boolean(),
  /** Lines the runner reported as errors. */
  errors: z.array(line).max(1_000),
  /** Where the log opens: the failing step's first line, else the first error. */
  focus: line.nullable(),
});
export type ForgeCheckLog = z.infer<typeof ForgeCheckLog>;

export const ForgeCheckRun = z.object({
  id: positive,
  name: text,
  status: ForgeCheck.shape.status,
  conclusion: z.string().max(256).nullable(),
  url: text.nullable(),
  /** What the app reported: all an external (non-Actions) check has instead of a log. */
  output: z.object({ title: text.nullable(), summary: text.nullable(), text: text.nullable() }),
  /** The GitHub Actions job behind the check; null for checks from other apps. */
  workflow: z
    .object({
      runId: positive,
      /** The run attempt this job belongs to; a re-run starts the next one. */
      attempt: positive,
      jobId: positive,
      steps: z.array(ForgeCheckStep).max(1_000),
    })
    .nullable(),
  /** Null when the check has no log, or an Actions log couldn't be read (`logUnavailable`). */
  log: ForgeCheckLog.nullable(),
  logUnavailable: z.boolean(),
  annotations: z.array(ForgeCheckAnnotation).max(100),
  annotationsTruncated: z.boolean(),
});
export type ForgeCheckRun = z.infer<typeof ForgeCheckRun>;

const scope = { workspaceId: WorkspaceId, repository: ForgeRepository.optional() };
export const ForgeCheckOperations = [
  z.object({
    op: z.literal("forge.pr.check"),
    ...scope,
    /** The check run's id: `ForgeCheck.id` is `check:<id>`. */
    checkRunId: positive,
    /** `ForgeCheck.jobId`: present for GitHub Actions jobs, whose log is read with the run. */
    jobId: positive.optional(),
  }),
] as const;
export const ForgeCheckResults = [
  z.object({ resource: z.literal("prCheck"), value: ForgeCheckRun }),
] as const;

export const ForgeCheckAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rerun"),
    runId: positive,
    /** The attempt the person saw. A run already past it was re-run, and isn't again. */
    attempt: positive,
    jobs: z.enum(["failed", "all"]),
  }),
  /**
   * Stop a workflow run that is still going; one already finished is left as it is. `attempt`
   * is the one the person saw: once the run was re-run, the newer attempt is never cancelled.
   */
  z.object({ kind: z.literal("cancel"), runId: positive, attempt: positive }),
]);
export type ForgeCheckAction = z.infer<typeof ForgeCheckAction>;
export const ForgeHostedChecksCommand = z.object({
  type: z.literal("forge.hosted.checks"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  action: ForgeCheckAction,
});
export type ForgeHostedChecksCommand = z.infer<typeof ForgeHostedChecksCommand>;
