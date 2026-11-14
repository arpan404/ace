import type { CommandResult, WorktreeCreationProgress } from "@ace/protocol";
import type { ReturnedStart } from "@/lib/returned-start.ts";
import { sendFailure } from "../items/send-failure.ts";

// The pure rules are shared with the phone (`@ace/ui-core`).
export { worktreeSpeaks, worktreeUnmade } from "@ace/ui-core";

/** The worktree's own words for the refusals that don't carry any. */
const unmadeWords: Record<string, string> = {
  workspace_unavailable: "Couldn't create the worktree. Try again or use the local checkout.",
  workspace_busy:
    "Couldn't create the worktree: ace is already making several. Try again in a moment.",
};

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
