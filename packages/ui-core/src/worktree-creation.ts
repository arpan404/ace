import type { WorktreeCreationProgress } from "@ace/protocol";
import { formatDuration } from "./time.ts";

/*
 * How a new thread's worktree creation reads (docs/daemon/worktree-creation.md): one line per
 * step the daemon has reached, the step in flight with checkout's percent. The settled
 * summary is retained for tests but never shown in chat. Pure over the daemon's progress report.
 */

type Progress = WorktreeCreationProgress;
export type WorktreeStep = Exclude<Progress["step"], "done">;

export const worktreeStepLabels: Record<WorktreeStep, string> = {
  preparing: "Preparing workspace",
  fetching: "Fetching the base branch",
  creating: "Creating the branch",
  checking_out: "Checking out files",
  setup: "Running setup",
};

export interface WorktreeStepRow {
  step: WorktreeStep;
  label: string;
  /** `stopped`: the step was in flight when the person cancelled. */
  state: "done" | "running" | "failed" | "stopped";
  /** How long it took, or had taken at the last report. */
  elapsedMs: number;
  /** Checkout's share of files written, while it runs. */
  percent: number | undefined;
}

/** The steps reached so far, oldest first; the last is the one in flight until it settles. */
export function worktreeStepRows(progress: Progress): WorktreeStepRow[] {
  const reached = progress.steps.filter(
    (entry): entry is { step: WorktreeStep; startedAt: number; elapsedMs: number } =>
      entry.step !== "done",
  );
  return reached.map((entry, index) => {
    const current = index === reached.length - 1 && progress.step === entry.step;
    const state: WorktreeStepRow["state"] = !current
      ? "done"
      : progress.state === "running" || progress.state === "cancelling"
        ? "running"
        : progress.state === "failed"
          ? "failed"
          : progress.state === "cancelled"
            ? "stopped"
            : "done";
    return {
      step: entry.step,
      label: worktreeStepLabels[entry.step],
      state,
      elapsedMs: entry.elapsedMs,
      percent: state === "running" && entry.step === "checking_out" ? progress.percent : undefined,
    };
  });
}

/** The card's heading: what is happening, or how it ended. */
export function worktreeHeadline(progress: Progress): string {
  switch (progress.state) {
    case "running":
      return "Creating a worktree";
    case "cancelling":
      return "Cancelling the worktree";
    case "cancelled":
      return "Worktree cancelled";
    case "failed":
      return "Couldn't create the worktree";
    case "done":
      return "Worktree ready";
    case "local":
      return "Using the local checkout";
  }
}

/** The short form for the composer's tab: "Creating worktree…", "Checking out files · 48%". */
export function worktreeTabLabel(progress: Progress | undefined): string {
  if (!progress || progress.state === "running") return "Creating worktree…";
  if (progress.state === "cancelling") return "Cancelling worktree…";
  return worktreeHeadline(progress);
}

/** "Checking out files · 48%": the step in flight, for the tab beside its label. */
export function worktreeCurrentStep(progress: Progress | undefined): string | undefined {
  if (!progress || (progress.state !== "running" && progress.state !== "cancelling"))
    return undefined;
  const row = worktreeStepRows(progress).at(-1);
  if (!row) return undefined;
  return row.percent === undefined ? row.label : `${row.label} · ${row.percent}%`;
}

const failure = "We couldn't create the worktree. Try again or use the local checkout.";
const cancelled = "Your message hasn't been sent. Retry, or send it on the local checkout.";

/** Why it stopped, in the daemon's fixed words; nothing while it runs or once it worked. */
export function worktreeNote(progress: Progress): string | undefined {
  if (progress.state === "failed") return progress.message ?? failure;
  if (progress.state === "cancelled")
    return progress.cleanupComplete ? cancelled : (progress.message ?? cancelled);
  return undefined;
}

/** "Worktree ready · fix/login-timeout · 4.2s": retained but never shown in chat. */
export function worktreeSummary(progress: Progress, branch?: string | null): string {
  const parts = [worktreeHeadline(progress)];
  if (branch && progress.state === "done") parts.push(branch);
  parts.push(formatDuration(progress.elapsedMs));
  return parts.join(" · ");
}

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
  "preparation_timeout",
  "auth_failed",
  "remote_unreachable",
]);

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
export function worktreeSpeaks(progress: Progress | undefined, code: string | undefined): boolean {
  if (!progress) return false;
  if (progress.state !== "failed" || !code) return true;
  return code === "worktree_cancelled" || code === "setup_failed" || worktreeUnmade(code);
}

/** Why the daemon turned a card's action down, or `offline` when it couldn't be asked. */
export type WorktreeActionRefusal =
  | "busy"
  | "cleanup_required"
  | "settled"
  | "not_found"
  | "forbidden"
  | "offline";

export const worktreeRefusalWords: Record<WorktreeActionRefusal, string> = {
  busy: "Another action on this worktree is still running. Try again in a moment.",
  cleanup_required: "Cleanup hasn't finished, so this can't run yet.",
  settled: "It had already finished.",
  not_found: "The daemon no longer has this worktree request.",
  forbidden: "This device isn't allowed to change it.",
  offline: "Couldn't reach the daemon. Try again once connected.",
};

/** A card's action as it reads, and while it is on its way. */
export const worktreeActionWords: Record<
  Progress["actions"][number],
  { label: string; busy: string }
> = {
  local: { label: "Don't use worktree", busy: "Switching…" },
  cancel: { label: "Cancel", busy: "Cancelling…" },
  retry: { label: "Retry", busy: "Retrying…" },
  continue: { label: "Continue without setup", busy: "Continuing…" },
};

/** Left to right: the way out first, the step forward last. */
export const worktreeActionOrder = ["local", "cancel", "retry", "continue"] as const;
