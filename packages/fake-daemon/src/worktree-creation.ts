import {
  Command,
  ThreadId,
  type CommandResult,
  type ServerMessage,
  type ClientMessage,
  type WorktreeCreationProgress,
} from "@ace/protocol";

type Progress = WorktreeCreationProgress;
type Send = (message: ServerMessage) => void;
type Draft = {
  command: Command;
  progress: Progress;
  stop?: () => void;
  resolve?: (result: CommandResult) => void;
  send: Send;
};
/** Wire-only simulation: direct command() remains synchronous for scripted fixtures. */
export class FakeWorktreeCreations {
  private drafts = new Map<string, Draft>();
  private now: () => number;
  private schedule: (callback: () => void, delay: number) => () => void;
  private slow: boolean;
  private execute: (command: Command) => CommandResult;
  private persist: (progress: Progress) => void;
  constructor(
    now: () => number,
    schedule: (callback: () => void, delay: number) => () => void,
    slow: boolean,
    execute: (command: Command) => CommandResult,
    persist: (progress: Progress) => void,
  ) {
    this.now = now;
    this.schedule = schedule;
    this.slow = slow;
    this.execute = execute;
    this.persist = persist;
  }
  start(command: Command, send: Send): Promise<CommandResult> {
    const prior = this.drafts.get(command.id);
    if (prior?.resolve)
      return Promise.resolve({
        commandId: command.id,
        ok: false,
        error: "thread_creation_in_progress",
      });
    if (!prior && this.drafts.size >= 16)
      return Promise.resolve({ commandId: command.id, ok: false, error: "workspace_busy" });
    const p = command.payload;
    const progress: Progress = {
      commandId: command.id,
      ...("threadId" in p && p.threadId ? { threadId: ThreadId.parse(p.threadId) } : {}),
      attempt: (prior?.progress.attempt ?? 0) + 1,
      state: "running",
      step: "preparing",
      startedAt: this.now(),
      elapsedMs: 0,
      steps: [],
      details: [],
      cleanupComplete: false,
      actions: ["cancel", "local"],
    };
    const draft: Draft = { command, progress, send };
    this.drafts.set(command.id, draft);
    const steps: { step: Progress["step"]; percent?: number }[] = [
      { step: "preparing" },
      ...((p.type === "thread.create" || p.type === "thread.prepare") && p.base?.remote
        ? [{ step: "fetching" as const }]
        : []),
      { step: "creating" },
      ...[0, 12, 29, 48, 67, 85, 100].map((percent) => ({
        step: "checking_out" as const,
        percent,
      })),
      { step: "setup" },
      { step: "done" },
    ];
    return new Promise((resolve) => {
      draft.resolve = resolve;
      let index = 0;
      const advance = () => {
        const next = steps[index++];
        if (!next) {
          const result = this.execute(command);
          this.finish(draft, result.ok ? "done" : "failed", result);
          return;
        }
        const time = this.now();
        const previous = progress.steps.at(-1);
        if (previous) previous.elapsedMs = Math.max(0, time - previous.startedAt);
        if (!previous || previous.step !== next.step)
          progress.steps.push({ step: next.step, startedAt: time, elapsedMs: 0 });
        progress.step = next.step;
        delete progress.percent;
        if (next.percent !== undefined) progress.percent = next.percent;
        progress.details.push(
          next.percent !== undefined
            ? `Checking out files: ${next.percent}%`
            : `Worktree ${next.step}`,
        );
        this.emit(draft);
        draft.stop = this.schedule(advance, this.slow ? 1500 : 80);
      };
      advance();
    });
  }
  handle(
    message: Extract<ClientMessage, { type: "worktree.creation.request" }>,
    device: string,
    send: Send,
  ): void {
    const draft = this.drafts.get(message.commandId);
    const response = (error?: "not_found" | "busy" | "settled") =>
      send({
        type: "worktree.creation.result",
        requestId: message.requestId,
        ok: !error,
        ...(error ? { error } : {}),
      });
    if (!draft || draft.command.deviceId !== device) {
      response("not_found");
      return;
    }
    if (message.action === "get") {
      send({
        type: "worktree.creation.result",
        requestId: message.requestId,
        ok: true,
        progress: draft.progress,
      });
      return;
    }
    if (message.action === "retry") {
      if (draft.resolve) {
        response("busy");
        return;
      }
      response();
      void this.start(draft.command, send).then((result) =>
        send({ type: "commandResult", ...result }),
      );
      return;
    }
    if (message.action === "cancel" && !draft.resolve) {
      response("settled");
      return;
    }
    draft.stop?.();
    draft.send = send;
    response();
    if (message.action === "cancel")
      this.finish(draft, "cancelled", {
        commandId: draft.command.id,
        ok: false,
        error: "worktree_cancelled",
      });
    else {
      const p = draft.command.payload;
      if (p.type !== "thread.create" && p.type !== "thread.prepare") return;
      const { base: _base, baseBranch: _baseBranch, ...rest } = p;
      const result = this.execute(
        Command.parse({ ...draft.command, payload: { ...rest, mode: "local" } }),
      );
      const pending = Boolean(draft.resolve);
      this.finish(draft, result.ok ? "local" : "failed", result);
      if (!pending) send({ type: "commandResult", ...result });
    }
  }
  private finish(draft: Draft, state: Progress["state"], result: CommandResult): void {
    draft.stop?.();
    draft.progress.state = state;
    draft.progress.cleanupComplete = true;
    draft.progress.actions = state === "failed" || state === "cancelled" ? ["retry", "local"] : [];
    delete draft.progress.message;
    if (state === "failed")
      draft.progress.message =
        "We couldn't create the worktree. Try again or use the local checkout.";
    if (state === "cancelled")
      draft.progress.message = "Worktree creation cancelled. Your first message is still queued.";
    const time = this.now();
    draft.progress.elapsedMs = Math.max(0, time - draft.progress.startedAt);
    const current = draft.progress.steps.at(-1);
    if (current) current.elapsedMs = Math.max(0, time - current.startedAt);
    this.persist(draft.progress);
    this.emit(draft);
    draft.resolve?.(result);
    delete draft.resolve;
    if (result.ok) this.drafts.delete(draft.command.id);
  }
  private emit(draft: Draft): void {
    draft.progress.elapsedMs = Math.max(0, this.now() - draft.progress.startedAt);
    draft.send({ type: "worktree.creation.progress", ...draft.progress });
  }
}
