import { z } from "zod";
import { ForgeCheckLog } from "./forge-checks.ts";
import { ForgePrRef } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

/*
 * Verify: the daemon runs a project's check command against pull requests on this machine.
 *
 * - A `check` run tests one PR: a temporary worktree at the PR's head, the project's worktree
 *   setup, then the check command. Its result reads as that PR's "Local" check.
 * - A `merge` run verifies, then merges, several PRs: a temporary worktree at the base branch,
 *   each PR head merged into it in order, setup and the check command once on the combined
 *   tree. Only when that passes, and the base has not moved since, does it merge each PR on
 *   GitHub in the same order, each pinned to the head it tested. It stops at the first failure.
 *
 * One run at a time per project; later runs queue. A run's worktree is removed when it settles;
 * its log is kept. A daemon restart settles a run that was preparing or checking as
 * `interrupted`; one that was merging on GitHub settles from what GitHub reports.
 */

const requestId = z.string().min(1).max(256);
const instant = z.number().int().nonnegative();
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);

const VerifyRunId = z.string().min(1).max(64);
export type VerifyRunId = z.infer<typeof VerifyRunId>;

/** A PR as the person saw it: verification and merging are pinned to this head. */
const VerifyPr = z.object({
  pr: ForgePrRef,
  headSha: sha,
  title: z.string().max(512).optional(),
});
export type VerifyPr = z.infer<typeof VerifyPr>;

/** Most PRs one merge run takes. */
export const verifyMergeLimit = 10;

const VerifyTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), pr: VerifyPr }),
  z.object({
    kind: z.literal("merge"),
    /** Merged locally, then on GitHub, in this order. All share one base branch. */
    prs: z.array(VerifyPr).min(1).max(verifyMergeLimit),
    method: z.enum(["merge", "squash", "rebase"]),
  }),
]);
export type VerifyTarget = z.infer<typeof VerifyTarget>;

/**
 * - `queued`: waiting for the project's earlier run.
 * - `running`: fetching, combining, setting up or checking.
 * - `passed` / `failed`: a check run's outcome.
 * - `merging`: a merge run passed its check and is merging on GitHub.
 * - `merged`: every PR of a merge run merged.
 * - `stopped`: a merge run stopped before or during GitHub merges; `failure` says why and
 *   `merged` lists any PRs that did merge.
 * - `cancelled`: the person stopped it before any GitHub merge.
 * - `interrupted`: a daemon restart ended it before any GitHub merge.
 */
const VerifyState = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "merging",
  "merged",
  "stopped",
  "cancelled",
  "interrupted",
]);
export type VerifyState = z.infer<typeof VerifyState>;

/** Whether a run has settled: nothing more happens to it. */
export const verifySettled: readonly VerifyState[] = [
  "passed",
  "failed",
  "merged",
  "stopped",
  "cancelled",
  "interrupted",
];

/**
 * One step, in order. `fetch` reads the base and every head; `combine` merges one PR locally
 * (merge runs); `setup` runs the project's worktree setup; `check` runs the check command;
 * `merge` merges one PR on GitHub (merge runs).
 */
const VerifyStep = z.object({
  kind: z.enum(["fetch", "combine", "setup", "check", "merge"]),
  pr: z.number().int().positive().optional(),
  state: z.enum(["pending", "running", "done", "failed", "skipped"]),
  startedAt: instant.optional(),
  endedAt: instant.optional(),
});
export type VerifyStep = z.infer<typeof VerifyStep>;

/**
 * Why a run did not pass or did not finish merging, in words a person can act on.
 * - `no_command`: the project has no check command (set one, or add a `check` script).
 * - `head_moved`: a PR's head is no longer the one selected; look again and retry.
 * - `conflict`: `pr` does not merge cleanly onto the base plus the PRs before it (`with`, the
 *   last one merged before it, when there is one).
 * - `base_moved`: the base branch moved after the check passed; nothing was merged.
 * - `merge_refused`: GitHub refused to merge `pr`; the ones before it merged.
 * - `merge_uncertain`: GitHub's answer for `pr` was lost; the PR page settles it.
 */
const VerifyFailure = z.object({
  code: z.enum([
    "no_command",
    "fetch_failed",
    "head_moved",
    "conflict",
    "setup_failed",
    "check_failed",
    "base_moved",
    "merge_refused",
    "merge_uncertain",
    "unavailable",
    "internal",
  ]),
  message: z.string().max(512),
  pr: z.number().int().positive().optional(),
  with: z.number().int().positive().optional(),
});
export type VerifyFailure = z.infer<typeof VerifyFailure>;

export const VerifyRun = z.object({
  id: VerifyRunId,
  workspaceId: WorkspaceId,
  target: VerifyTarget,
  state: VerifyState,
  /** The check command as it ran (or will run). */
  command: z.string().max(1024),
  /** The base a merge run combined onto, once read. */
  base: z.object({ branch: z.string().max(1024), sha }).optional(),
  steps: z.array(VerifyStep).max(32),
  createdAt: instant,
  startedAt: instant.optional(),
  endedAt: instant.optional(),
  /** The check command's exit code, once it exited. */
  exitCode: z.number().int().nullable().optional(),
  failure: VerifyFailure.optional(),
  /** PR numbers a merge run merged on GitHub, in order. */
  merged: z.array(z.number().int().positive()).max(verifyMergeLimit),
  /** Grows with every change to this run, so a client keeps the newest copy it has seen. */
  revision: z.number().int().nonnegative(),
});
export type VerifyRun = z.infer<typeof VerifyRun>;

/** Most runs a list returns: the latest check per PR and the latest merge runs, newest first. */
export const verifyListLimit = 100;

/**
 * - `list`: a project's latest runs (the newest check per PR head, every live run, and recent
 *   merge runs) and the check command its runs use.
 * - `log`: one run's output, newest kept.
 * - `start`: queue a run. Needs operate scope.
 * - `cancel`: stop a queued or running run before it merges anything. Needs operate scope.
 */
const VerifyOperation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspaceId: WorkspaceId }),
  z.object({ action: z.literal("log"), runId: VerifyRunId }),
  z.object({ action: z.literal("start"), workspaceId: WorkspaceId, target: VerifyTarget }),
  z.object({ action: z.literal("cancel"), runId: VerifyRunId }),
]);
export type VerifyOperation = z.infer<typeof VerifyOperation>;
export const VerifyRequest = z.object({
  type: z.literal("verify.request"),
  requestId,
  op: VerifyOperation,
});
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export const VerifyResult = z.object({
  type: z.literal("verify.result"),
  requestId,
  ok: z.boolean(),
  /**
   * `no_command`: the project has no check command; `busy`: too many queued runs;
   * `settled`: cancel came after the run settled or started merging on GitHub.
   */
  error: z
    .enum(["not_found", "forbidden", "invalid", "no_command", "busy", "settled", "unavailable"])
    .optional(),
  /** `list`: the runs, newest first. */
  runs: z.array(VerifyRun).max(verifyListLimit).optional(),
  /** `list`: the command runs use; null when the project has none. */
  command: z.string().max(1024).nullable().optional(),
  /** `start` and `cancel`: the run as it now stands. */
  run: VerifyRun.optional(),
  /** `log`: the run's output so far. */
  log: ForgeCheckLog.optional(),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/** Pushed to every device allowed to read after any change to a run. */
export const VerifyChanged = z.object({
  type: z.literal("verify.changed"),
  run: VerifyRun,
});
export type VerifyChanged = z.infer<typeof VerifyChanged>;
