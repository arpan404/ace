import type { WorktreeCreationProgress } from "@ace/protocol";
import { sendFailure } from "../items/send-failure.ts";

/** Refusals the daemon gives when a new thread's worktree couldn't be made. */
const unmade = new Set(["workspace_unavailable", "workspace_busy"]);

/** The worktree's own words for the refusals that don't carry any. */
const unmadeWords: Record<string, string> = {
  workspace_unavailable: "Couldn't create the worktree. Try again or use the local checkout.",
  workspace_busy:
    "Couldn't create the worktree: ace is already making several. Try again in a moment.",
};

/**
 * Whether a new thread's start was refused because its worktree couldn't be made: not the
 * message's own refusal (a model that's gone), and not a cancel the person chose.
 */
export function worktreeUnmade(code: string | undefined): boolean {
  if (!code || code === "worktree_cancelled") return false;
  return code.startsWith("worktree_") || unmade.has(code);
}

/**
 * Whether the worktree's card speaks for a new thread's start. It does while the worktree is
 * made and when making it stopped, but not when the start was then refused for the message's
 * own reason (a model that's gone): that refusal is the message's, said under its bubble.
 */
export function worktreeSpeaks(
  progress: WorktreeCreationProgress | undefined,
  code: string | undefined,
): boolean {
  if (!progress) return false;
  if (progress.state !== "failed" || !code) return true;
  return code === "worktree_cancelled" || worktreeUnmade(code);
}

/**
 * Why, in words: the refusal's own reason when it names one ("That branch doesn't exist any
 * more…"), else what the worktree's making reported, else the worktree named in the refusal's
 * place, never a generic "couldn't complete that action".
 */
export function worktreeUnmadeReason(
  code: string | undefined,
  progress: WorktreeCreationProgress | undefined,
): string {
  if (code?.startsWith("worktree_")) return sendFailure(code);
  return (
    (progress?.state === "failed" ? progress.message : undefined) ??
    (code && unmadeWords[code]) ??
    "Couldn't create the worktree. Try again or use the local checkout."
  );
}
