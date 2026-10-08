import type { WorktreeCreationProgress } from "@ace/protocol";
import { formatDuration } from "./time.ts";

/*
 * How a new thread's worktree creation reads (docs/daemon/worktree-creation.md): one line per
 * step the daemon has reached, the step in flight with checkout's percent, and a one-line
 * summary once it has settled. Pure over the daemon's progress report.
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

/** "Worktree ready · fix/login-timeout · 4.2s": the settled card, folded to one line. */
export function worktreeSummary(progress: Progress, branch?: string | null): string {
  const parts = [worktreeHeadline(progress)];
  if (branch && progress.state === "done") parts.push(branch);
  parts.push(formatDuration(progress.elapsedMs));
  return parts.join(" · ");
}
