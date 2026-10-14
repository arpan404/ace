import { z } from "zod";
import { GitError, type GitService, type StackReplayResult } from "@ace/git";
import { ForgeError, planStackSync, reviewAfterSync, type GitHubForge } from "@ace/forge";
import { canPublishStack } from "@ace/forge/stack-plan";
import { ForgeStackExpected, type ForgeStack, type ForgeStackOperation } from "@ace/protocol";

const sha = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
/** What an unfinished sync needs to continue or to restore the rebased layers. */
export const StackSyncProgress = z.object({
  /** Every active layer's rebased head before the sync, restored by Abort. */
  heads: z
    .array(z.object({ branch: z.string(), head: sha }))
    .min(1)
    .max(100),
  current: z.string(),
  stage: z.enum(["replay", "restack"]),
  /** Moved layers, bottom-up, whose replay has not started. */
  remaining: z.array(z.object({ branch: z.string(), reviewed: sha, current: sha })).max(100),
  /** The GitHub heads the person confirmed; they become the reviewed revisions when done. */
  requested: ForgeStackExpected,
  moved: z.array(z.number().int().positive()).min(1).max(100),
});
export type StackSyncProgress = z.infer<typeof StackSyncProgress>;
export type StackSyncGit = Pick<
  GitService,
  | "fetchBranch"
  | "branchHead"
  | "switchBranch"
  | "replayStackLayers"
  | "continueStackReplay"
  | "restoreStackBranches"
>;
/** A step's result: the operation to show, plus the progress or new review to record. */
export type StackSyncStep =
  | { operation: ForgeStackOperation; progress: StackSyncProgress }
  | { operation: ForgeStackOperation; progress: null; review: ForgeStackExpected | null };

type Context = {
  cwd: string;
  git: StackSyncGit;
  backend: GitHubForge;
  signal: AbortSignal;
  allowed: () => boolean;
};

const layers = (numbers: readonly number[]) => numbers.map((number) => `#${number}`).join(", ");

/**
 * Bring collaborator commits GitHub gained after review into a rebased stack: fetch each moved
 * layer's head, replay its new commits onto the local layer, then restack the layers above with
 * gh stack. `begin` records the operation immediately before the first branch changes. A
 * refusal before that point returns a failed operation and changes nothing.
 */
export async function startStackSync(
  context: Context,
  number: number,
  reviewed: ForgeStackExpected,
  requested: ForgeStackExpected,
  begin: (progress: StackSyncProgress) => void,
): Promise<StackSyncStep | { refused: ForgeStackOperation }> {
  const { cwd, git, backend, signal } = context;
  const [stack, local] = await Promise.all([
    backend.prStack(number, signal),
    backend.localStack(signal),
  ]);
  if (!stack || !syncable(stack) || local.branches.some((branch) => branch.isQueued))
    throw new ForgeError("conflict");
  const plan = planStackSync(reviewed, requested, local, stack);
  if (!plan.ok) throw new ForgeError("conflict");
  for (const move of plan.moves) {
    await git.fetchBranch({
      repo: cwd,
      remote: "origin",
      branch: move.branch,
      timeoutMs: 120_000,
      signal,
    });
    // GitHub moved again after the person confirmed: they must review the newer head first.
    if (
      (await git.branchHead({ repo: cwd, branch: move.branch, remote: "origin" })) !== move.current
    )
      throw new ForgeError("conflict");
  }
  if (!context.allowed()) throw new ForgeError("forbidden");
  const progress: StackSyncProgress = {
    heads: local.branches
      .filter((branch) => !branch.isMerged)
      .map((branch) => ({ branch: branch.name, head: branch.head })),
    current: local.currentBranch,
    stage: "replay",
    remaining: [],
    requested,
    moved: plan.moves.map((move) => move.number),
  };
  let result: StackReplayResult;
  let dispatched = false;
  try {
    result = await git.replayStackLayers({
      worktree: cwd,
      layers: plan.moves.map((move) => ({
        branch: move.branch,
        reviewed: move.reviewed,
        current: move.current,
      })),
      signal,
      beforeDispatch: () => {
        begin(progress);
        dispatched = true;
      },
    });
  } catch (error) {
    // The replay checks every layer before it changes a branch; a refusal there moved nothing.
    if (!dispatched && isRefusal(error))
      return {
        refused: {
          action: "sync",
          state: "failed",
          message: `${error.message}. Nothing changed locally or on GitHub.`,
        },
      };
    throw error;
  }
  return afterReplay(context, progress, result);
}

/** Continue a sync that stopped on a conflict, from the step that stopped. */
export async function continueStackSync(
  context: Context,
  progress: StackSyncProgress,
): Promise<StackSyncStep> {
  if (!context.allowed()) throw new ForgeError("forbidden");
  if (progress.stage === "restack") return afterRestack(context, progress, "continue");
  const result = await context.git.continueStackReplay({
    worktree: context.cwd,
    remaining: progress.remaining,
    signal: context.signal,
  });
  return afterReplay(context, progress, result);
}

/** Stop the sync and put every layer back at its rebased head. Nothing is pushed. */
export async function abortStackSync(
  context: Context,
  progress: StackSyncProgress,
): Promise<StackSyncStep> {
  if (!context.allowed()) throw new ForgeError("forbidden");
  // gh stack's own restack keeps state that only gh stack can clear.
  if (progress.stage === "restack")
    await context.backend.restackStack("abort", context.signal, context.allowed);
  await context.git.restoreStackBranches({
    worktree: context.cwd,
    heads: progress.heads,
    current: progress.current,
    signal: context.signal,
  });
  return {
    operation: {
      action: "abort",
      state: "push_partial",
      message:
        "Restored the rebased layers. Nothing was pushed; GitHub's newer commits are still not in the stack.",
    },
    progress: null,
    review: null,
  };
}

async function afterReplay(
  context: Context,
  progress: StackSyncProgress,
  result: StackReplayResult,
): Promise<StackSyncStep> {
  if (result.state === "conflict")
    return {
      operation: {
        action: "sync",
        state: "conflict",
        stage: "sync",
        message: `Replaying collaborator commits onto ${result.branch} needs conflict resolution. Resolve and stage the files, then Continue, or Abort to restore the rebased layers.`,
      },
      progress: { ...progress, stage: "replay", remaining: result.remaining },
    };
  return afterRestack(context, { ...progress, stage: "restack", remaining: [] }, "upstack");
}

async function afterRestack(
  context: Context,
  progress: StackSyncProgress,
  step: "upstack" | "continue",
): Promise<StackSyncStep> {
  const restacked = await context.backend.restackStack(step, context.signal, context.allowed);
  if (restacked === "conflict")
    return {
      operation: {
        action: "sync",
        state: "conflict",
        stage: "sync",
        message:
          "Restacking the layers above the collaborator commits needs conflict resolution. Resolve and stage the files, then Continue, or Abort to restore the rebased layers.",
      },
      progress,
    };
  if (restacked !== "restacked")
    return {
      operation: {
        action: "sync",
        state: "uncertain",
        stage: "sync",
        message:
          "gh stack could not restack the layers above the collaborator commits. Nothing was pushed. Abort to restore the rebased layers.",
      },
      progress,
    };
  await context.git.switchBranch({
    worktree: context.cwd,
    branch: progress.current,
    allowUncommitted: false,
  });
  const local = await context.backend.localStack(context.signal);
  return {
    operation: {
      action: "sync",
      state: "push_partial",
      message: `Brought GitHub's newer commits on ${layers(progress.moved)} into the stack. Nothing is pushed yet. Publish to update GitHub; each layer is leased to the head GitHub reports now.`,
    },
    progress: null,
    review: reviewAfterSync(progress.requested, local),
  };
}

function syncable(stack: ForgeStack) {
  return canPublishStack(stack) && stack.layers.every((layer) => layer.queueState === null);
}

/** Continue or Abort refused before any branch or replay state changed. */
export function unchangedRefusal(error: unknown): boolean {
  return (
    (error instanceof ForgeError && error.kind === "forbidden") ||
    (error instanceof GitError && error.code === "conflicts")
  );
}

function isRefusal(error: unknown): error is GitError {
  return (
    error instanceof GitError &&
    ["head_moved", "invalid_ref", "dirty_worktree", "conflicts"].includes(error.code)
  );
}
