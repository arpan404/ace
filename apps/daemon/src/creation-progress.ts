import { OutputLog } from "./creation-output.ts";
import {
  ThreadId,
  type Command,
  type CommandResult,
  type WorktreeCreationProgress,
} from "@ace/protocol";
import type { CreationFailure } from "./creation-failure.ts";

type Progress = WorktreeCreationProgress;
/** Bounded line framing precedes redaction, including secrets split across process chunks. */
export class CreationProgress {
  readonly controller = new AbortController();
  action: "cancel" | "local" | undefined;
  active = true;
  /** Continue after a failed setup script: admit the kept worktree without running setup. */
  skipSetup = false;
  /** The start's receipt, for a replay of the same command that attaches after a reconnect. */
  readonly settled: Promise<CommandResult>;
  private resolveSettled: (result: CommandResult) => void = () => {};
  private prOnly: boolean;
  private existingPr: boolean;
  private log: OutputLog;
  private now: () => number;
  private publish: (progress: Progress) => void;
  progress: Progress;
  constructor(
    command: Command,
    attempt: number,
    now: () => number,
    publish: (progress: Progress) => void,
  ) {
    this.now = now;
    this.publish = publish;
    this.settled = new Promise((resolve) => {
      this.resolveSettled = resolve;
    });
    const p = command.payload;
    this.existingPr = p.type === "forge.pr.worktree";
    this.prOnly =
      this.existingPr ||
      ((p.type === "thread.create" || p.type === "thread.prepare") && Boolean(p.pullRequest));
    this.progress = {
      commandId: command.id,
      ...("threadId" in p && p.threadId ? { threadId: ThreadId.parse(p.threadId) } : {}),
      attempt,
      state: "running",
      step: "preparing",
      startedAt: now(),
      elapsedMs: 0,
      steps: [],
      details: [],
      cleanupComplete: false,
      actions: this.prOnly ? ["cancel"] : ["cancel", "local"],
    };
    this.log = new OutputLog(this.progress.details);
    this.update("preparing");
  }
  update(step: Progress["step"], percent?: number): void {
    const time = this.now();
    const previous = this.progress.steps.at(-1);
    if (previous) previous.elapsedMs = Math.max(0, time - previous.startedAt);
    if (this.progress.step !== step || !previous) {
      this.flush();
      this.progress.steps.push({ step, startedAt: time, elapsedMs: 0 });
      delete this.progress.percent;
    }
    this.progress.step = step;
    if (percent !== undefined)
      this.progress.percent = Math.max(this.progress.percent ?? 0, percent);
    this.emit();
  }
  readonly stderr = (chunk: Buffer): void => {
    this.log.write(chunk);
    this.emit();
  };
  private flush(): void {
    this.log.flush();
  }
  stop(action: "cancel" | "local"): void {
    this.action = action;
    this.progress.state = "cancelling";
    this.progress.actions = [];
    this.emit();
    this.controller.abort();
  }
  settle(result: CommandResult): void {
    this.resolveSettled(result);
  }
  finish(state: Progress["state"], cleanupComplete: boolean, failure?: CreationFailure): void {
    this.active = false;
    this.flush();
    this.progress.state = state;
    this.progress.cleanupComplete = cleanupComplete;
    delete this.progress.error;
    delete this.progress.lockPath;
    const setupFailed = state === "failed" && failure?.error === "setup_failed";
    this.progress.actions =
      cleanupComplete && (state === "failed" || state === "cancelled")
        ? this.existingPr
          ? []
          : this.prOnly
            ? ["retry"]
            : setupFailed
              ? ["retry", "continue", "local"]
              : ["retry", "local"]
        : [];
    if (state === "failed")
      this.progress.message = this.prOnly
        ? "Could not prepare the selected PR head. Refresh the PR and try Work on PR again."
        : (failure?.detail.slice(0, 256) ??
          "We couldn't create the worktree. Try again or use the local checkout.");
    if (state === "failed" && failure) {
      this.progress.error = failure.error;
      if (failure.lockPath) this.progress.lockPath = failure.lockPath;
    }
    if (state === "cancelled")
      this.progress.message = this.existingPr
        ? "PR preparation cancelled. The previous checkout is retained."
        : "Worktree creation cancelled. Your first message is still queued.";
    if (!cleanupComplete)
      this.progress.message = "Worktree cleanup needs attention before this checkout can be used.";
    this.emit();
  }
  private emit(): void {
    const time = this.now();
    this.progress.elapsedMs = Math.max(0, time - this.progress.startedAt);
    const current = this.progress.steps.at(-1);
    if (current) current.elapsedMs = Math.max(0, time - current.startedAt);
    this.publish(this.progress);
  }
}
