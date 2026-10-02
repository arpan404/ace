import type { GitService } from "@ace/git";
import { LaneComparison, type OrchestrationState } from "@ace/protocol";

export async function compare(state: OrchestrationState, git: Pick<GitService, "diff">) {
  const results: LaneComparison[] = [];
  // Sequential requests bound in-flight patches; run contains at most 64 lanes.
  for (const lane of Object.values(state.lanes)) {
    if (!lane.artifact || !lane.worktree) continue;
    const diff = await git.diff({
      worktree: lane.worktree,
      from: { kind: "commit", ref: state.input.baseRef },
      to: { kind: "checkpoint", id: lane.artifact.checkpoint },
      maxPatchBytes: 65536,
    });
    results.push(
      LaneComparison.parse({
        laneId: lane.id,
        durationMs: Math.max(0, (lane.endedAt ?? lane.startedAt) - lane.startedAt),
        usage: lane.usage,
        artifact: lane.artifact,
        checksPassed: lane.checksPassed === true,
        files: diff.entries.slice(0, 4096),
        filesTruncated: diff.entries.length > 4096,
        patch: diff.patch,
        patchTruncated: diff.truncated,
      }),
    );
  }
  return results;
}
/** Applies checkpoint files to the pinned, clean target branch. @ace/git preserves index/HEAD. */
export async function mergeWinner(
  state: OrchestrationState,
  targetWorktree: string,
  git: Pick<GitService, "repositoryInfo" | "status" | "restoreCheckpoint">,
) {
  const lane = state.winner ? state.lanes[state.winner] : undefined;
  if (
    !lane?.artifact ||
    lane.phase !== "succeeded" ||
    state.open !== 0 ||
    state.stopReason === "budget_exhausted" ||
    state.stopReason === "cancelled"
  )
    throw new Error("winner_not_available");
  const info = await git.repositoryInfo(targetWorktree);
  if (info.branch !== state.input.targetBranch || info.head !== state.input.baseRef)
    throw new Error("target_changed");
  const status = await git.status(targetWorktree);
  if (
    status.staged.length ||
    status.unstaged.length ||
    status.untracked.length ||
    status.conflicted.length
  )
    throw new Error("target_dirty");
  const result = await git.restoreCheckpoint({
    worktree: targetWorktree,
    checkpoint: lane.artifact.checkpoint,
  });
  return { safetyCheckpoint: result.safetyCheckpointId };
}
