import type { WorktreeCreationProgress } from "@ace/protocol";
import { sendFailure } from "../items/send-failure.ts";

/** Refusals the daemon gives when a new thread's worktree couldn't be made. */
const unmade = new Set(["workspace_unavailable", "workspace_busy"]);

/**
 * Whether a new thread's start was refused because its worktree couldn't be made: not the
 * message's own refusal (a model that's gone), and not a cancel the person chose.
 */
export function worktreeUnmade(code: string | undefined): boolean {
  if (!code || code === "worktree_cancelled") return false;
  return code.startsWith("worktree_") || unmade.has(code);
}

/**
 * Why, in words: the refusal's own reason when it names one ("That branch doesn't exist any
 * more…"), else what the worktree's making reported.
 */
export function worktreeUnmadeReason(
  code: string | undefined,
  progress: WorktreeCreationProgress | undefined,
): string {
  if (code?.startsWith("worktree_")) return sendFailure(code);
  return (progress?.state === "failed" ? progress.message : undefined) ?? sendFailure(code);
}
