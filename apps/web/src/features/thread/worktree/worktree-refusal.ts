import type { CommandResult, WorktreeCreationProgress } from "@ace/protocol";
import type { ReturnedStart } from "@/lib/returned-start.ts";
import { sendFailure } from "../items/send-failure.ts";

/** Refusals the daemon gives when a new thread's worktree couldn't be made. */
const unmade = new Set([
  "workspace_unavailable",
  "workspace_busy",
  "workspace_preparation_collision",
  "workspace_cleanup_required",
  "not_a_repo",
  "no_commits",
  "invalid_ref",
  "branch_exists",
  "ref_conflict",
  "auth_failed",
  "remote_unreachable",
]);

/** The worktree's own words for the refusals that don't carry any. */
const unmadeWords: Record<string, string> = {
  workspace_unavailable: "Couldn't create the worktree. Try again or use the local checkout.",
  workspace_busy:
    "Couldn't create the worktree: ace is already making several. Try again in a moment.",
};

/**
 * Whether a new thread's start was refused because its worktree couldn't be made: not the
 * message's own refusal (a model that's gone), not a cancel the person chose, and not a setup
 * script that failed in a worktree the daemon kept (its card offers Continue).
 */
export function worktreeUnmade(code: string | undefined): boolean {
  if (!code || code === "worktree_cancelled" || code === "setup_failed") return false;
  return code.startsWith("worktree_") || code.startsWith("git_") || unmade.has(code);
}

/**
 * Whether the worktree's card speaks for a new thread's start. It does while the worktree is
 * made, when making it stopped, and when only its setup script failed, but not when the start
 * was then refused for the message's own reason (a model that's gone): that refusal is the
 * message's, said under its bubble.
 */
export function worktreeSpeaks(
  progress: WorktreeCreationProgress | undefined,
  code: string | undefined,
): boolean {
  if (!progress) return false;
  if (progress.state !== "failed" || !code) return true;
  return code === "worktree_cancelled" || code === "setup_failed" || worktreeUnmade(code);
}

/**
 * Why, in words: the daemon's own title and detail for the failure ("Git is locked", naming the
 * repository), else the refusal's reason when it names one, else what the worktree's making
 * reported, else the worktree named in the refusal's place, never a generic "couldn't
 * complete that action". The code goes with it so New thread can offer the next step.
 */
export function worktreeUnmadeReason(
  code: string | undefined,
  progress: WorktreeCreationProgress | undefined,
  receipt?: Pick<CommandResult, "title" | "detail"> | undefined,
): ReturnedStart {
  const failed = progress?.state === "failed" ? progress : undefined;
  const failure = failed?.error ?? code;
  const reason =
    receipt?.detail ??
    (code?.startsWith("worktree_") ? sendFailure(code) : undefined) ??
    failed?.message ??
    (code && unmadeWords[code]) ??
    "Couldn't create the worktree. Try again or use the local checkout.";
  return {
    ...(receipt?.title ? { title: receipt.title } : {}),
    reason,
    ...(failure ? { code: failure } : {}),
  };
}
