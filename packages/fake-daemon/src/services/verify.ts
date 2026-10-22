import {
  VerifyRun,
  verifySettled,
  type ForgeCheckLog,
  type ServerMessage,
  type VerifyFailure,
  type VerifyRequest,
  type VerifyResult,
  type VerifyStep,
  type VerifyTarget,
} from "@ace/protocol";

/** How a staged run fails; the message defaults to one for its code. */
export type FakeVerifyFailure = Omit<VerifyFailure, "message"> & { message?: string };

const messages: Record<VerifyFailure["code"], string> = {
  no_command: "The project has no check command.",
  fetch_failed: "Couldn't fetch from GitHub.",
  head_moved: "The pull request has new commits.",
  conflict: "The pull request doesn't merge cleanly.",
  setup_failed: "The worktree setup failed.",
  check_failed: "The check command failed.",
  base_moved: "The base branch moved.",
  merge_refused: "GitHub refused the merge.",
  merge_uncertain: "GitHub's answer was lost.",
  unavailable: "Verify is unavailable.",
  internal: "Something went wrong.",
};

/** The step a failure stops at: its kind, and for per-PR steps, its PR. */
function failsAt(failure: FakeVerifyFailure, step: VerifyStep): boolean {
  switch (failure.code) {
    case "conflict":
      return step.kind === "combine" && step.pr === failure.pr;
    case "setup_failed":
      return step.kind === "setup";
    case "check_failed":
      return step.kind === "check";
    case "merge_refused":
    case "merge_uncertain":
      return step.kind === "merge" && step.pr === failure.pr;
    case "base_moved":
      return step.kind === "merge";
    default:
      return step.kind === "fetch";
  }
}

const pending = (kind: VerifyStep["kind"], pr?: number): VerifyStep => ({
  kind,
  state: "pending",
  ...(pr === undefined ? {} : { pr }),
});

function plannedSteps(target: VerifyTarget): VerifyStep[] {
  if (target.kind === "check") return [pending("fetch"), pending("setup"), pending("check")];
  return [
    pending("fetch"),
    ...target.prs.map((pr) => pending("combine", pr.pr.number)),
    pending("setup"),
    pending("check"),
    ...target.prs.map((pr) => pending("merge", pr.pr.number)),
  ];
}

const live = (run: VerifyRun) => !verifySettled.includes(run.state);

/**
 * The daemon's Verify service, simulated: runs step through fetch, combine, setup, check and
 * merge on a timer (or one `advance()` at a time while `paused`), without processes or git.
 * Each run's ending comes from `outcome`, so a scenario stages a conflict or a failed check.
 * One run at a time per project; every change pushes `verify.changed`, as the daemon does.
 */
export class FakeVerify {
  /** Each project's check command; null for none. Unlisted projects run `bun run check`. */
  readonly commands = new Map<string, string | null>();
  /** How a run started now ends; undefined passes. */
  outcome: (target: VerifyTarget) => FakeVerifyFailure | undefined = () => undefined;
  /** Between steps. */
  stepMs = 700;
  /** Held: runs move only on `advance()`. */
  paused = false;
  /** Each PR a merge run merged on GitHub. */
  onMerged: ((workspaceId: string, number: number) => void) | undefined;
  /** Every start request, in order, as the daemon received it. */
  readonly started: { workspaceId: string; target: VerifyTarget }[] = [];
  private readonly runs = new Map<string, VerifyRun>();
  private readonly failures = new Map<string, FakeVerifyFailure | undefined>();
  private sequence = 0;
  private readonly clock: () => number;
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly schedule: (callback: () => void, delayMs: number) => void;
  constructor(input: {
    clock: () => number;
    broadcast: (message: ServerMessage) => void;
    schedule: (callback: () => void, delayMs: number) => void;
  }) {
    this.clock = input.clock;
    this.broadcast = input.broadcast;
    this.schedule = input.schedule;
  }
  command(workspaceId: string): string | null {
    const set = this.commands.get(workspaceId);
    return set === undefined ? "bun run check" : set;
  }
  /** Stage a run as the daemon would list and push it (a past local check, a live merge run). */
  seed(run: VerifyRun): void {
    const parsed = VerifyRun.parse(run);
    this.runs.set(parsed.id, parsed);
    this.broadcast({ type: "verify.changed", run: parsed });
  }
  /** Move every live run on by one step. */
  advance(): void {
    // Only the runs moving now: one a settled run lets begin waits for the next advance.
    const moving: string[] = [];
    for (const run of this.runs.values())
      if (run.state === "running" || run.state === "merging") moving.push(run.id);
    for (const id of moving) this.step(id);
  }
  handle(message: VerifyRequest): VerifyResult {
    const { op, requestId } = message;
    const reply = (patch: Partial<VerifyResult>): VerifyResult => ({
      type: "verify.result",
      requestId,
      ok: true,
      ...patch,
    });
    switch (op.action) {
      case "list":
        return reply({
          runs: [...this.runs.values()]
            .filter((run) => run.workspaceId === op.workspaceId)
            .toSorted((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
            .slice(0, 100),
          command: this.command(op.workspaceId),
        });
      case "log": {
        const run = this.runs.get(op.runId);
        return run ? reply({ log: this.log(run) }) : reply({ ok: false, error: "not_found" });
      }
      case "start": {
        const command = this.command(op.workspaceId);
        if (command === null) return reply({ ok: false, error: "no_command" });
        this.started.push({ workspaceId: op.workspaceId, target: op.target });
        const busy = [...this.runs.values()].some(
          (run) => run.workspaceId === op.workspaceId && live(run),
        );
        const id = `verify-${++this.sequence}`;
        const run = VerifyRun.parse({
          id,
          workspaceId: op.workspaceId,
          target: op.target,
          state: "queued",
          command,
          steps: plannedSteps(op.target),
          createdAt: this.clock(),
          merged: [],
          revision: 0,
        });
        this.failures.set(id, this.outcome(op.target));
        this.runs.set(id, run);
        if (!busy) this.begin(id);
        else this.changed(run);
        return reply({ run: this.runs.get(id) });
      }
      case "cancel": {
        const run = this.runs.get(op.runId);
        if (!run) return reply({ ok: false, error: "not_found" });
        if (!live(run) || run.state === "merging") return reply({ ok: false, error: "settled" });
        this.settle(run, "cancelled", (step) =>
          step.state === "pending" || step.state === "running" ? "skipped" : step.state,
        );
        return reply({ run: this.runs.get(run.id) });
      }
    }
  }
  private changed(run: VerifyRun): VerifyRun {
    const next = { ...run, revision: run.revision + 1 };
    this.runs.set(run.id, next);
    this.broadcast({ type: "verify.changed", run: next });
    return next;
  }
  private begin(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    const now = this.clock();
    const steps = run.steps.map((step, index) =>
      index === 0 ? { ...step, state: "running" as const, startedAt: now } : step,
    );
    const base =
      run.target.kind === "merge" ? { base: { branch: "main", sha: "b".repeat(40) } } : {};
    this.changed({ ...run, ...base, state: "running", startedAt: now, steps });
    this.later(id);
  }
  private later(id: string): void {
    if (this.paused) return;
    this.schedule(() => this.step(id), this.stepMs);
  }
  private step(id: string): void {
    const run = this.runs.get(id);
    if (!run || !live(run)) return;
    const at = run.steps.findIndex((step) => step.state === "running");
    const current = run.steps[at];
    if (!current) return;
    const now = this.clock();
    const failure = this.failures.get(id);
    if (failure && failsAt(failure, current)) {
      this.settle(
        { ...run, failure: { ...failure, message: failure.message ?? messages[failure.code] } },
        run.target.kind === "check" ? "failed" : "stopped",
        (step, index) =>
          index === at
            ? failure.code === "base_moved"
              ? "skipped"
              : "failed"
            : step.state === "pending"
              ? "skipped"
              : step.state,
        failure.code === "check_failed" ? 1 : undefined,
      );
      return;
    }
    const merged =
      current.kind === "merge" && current.pr !== undefined
        ? [...run.merged, current.pr]
        : run.merged;
    if (current.kind === "merge" && current.pr !== undefined)
      this.onMerged?.(run.workspaceId, current.pr);
    const steps = run.steps.map((step, index) =>
      index === at
        ? { ...step, state: "done" as const, endedAt: now }
        : index === at + 1
          ? { ...step, state: "running" as const, startedAt: now }
          : step,
    );
    const next = steps[at + 1];
    const checked = current.kind === "check" ? { exitCode: 0 } : {};
    if (!next) {
      this.settle(
        { ...run, ...checked, merged, steps },
        run.target.kind === "check" ? "passed" : "merged",
        (step) => step.state,
      );
      return;
    }
    this.changed({
      ...run,
      ...checked,
      merged,
      steps,
      state: next.kind === "merge" ? "merging" : "running",
    });
    this.later(id);
  }
  private settle(
    run: VerifyRun,
    state: VerifyRun["state"],
    stepState: (step: VerifyStep, index: number) => VerifyStep["state"],
    exitCode?: number,
  ): void {
    const now = this.clock();
    this.changed({
      ...run,
      state,
      endedAt: now,
      ...(exitCode === undefined ? {} : { exitCode }),
      steps: run.steps.map((step, index) => {
        const next = stepState(step, index);
        return next === step.state ? step : { ...step, state: next, endedAt: now };
      }),
    });
    const queued = [...this.runs.values()]
      .filter((other) => other.workspaceId === run.workspaceId && other.state === "queued")
      .toSorted((a, b) => a.createdAt - b.createdAt)[0];
    if (queued) this.begin(queued.id);
  }
  private log(run: VerifyRun): ForgeCheckLog {
    const lines = [`$ ${run.command}`];
    const errors: number[] = [];
    for (const step of run.steps) {
      if (step.state === "pending") continue;
      const what = step.pr === undefined ? step.kind : `${step.kind} #${step.pr}`;
      lines.push(`${what}: ${step.state}`);
      if (step.state === "failed") {
        errors.push(lines.length);
        lines.push(run.failure?.message ?? "failed");
      }
    }
    return { text: lines.join("\n"), truncated: false, errors, focus: errors[0] ?? null };
  }
}
