import type {
  ForgeCheckLog,
  VerifyChanged,
  VerifyResult,
  VerifyRun,
  VerifyTarget,
  WorkspaceId,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import { resolveCheckCommand } from "./check-command.ts";
import type { CheckShell } from "./check-process.ts";
import { CheckTrees } from "./check-trees.ts";
import { checkLog } from "./log-tail.ts";
import type { VerifyForge, VerifyGit } from "./ports.ts";
import { describeError } from "./run-errors.ts";
import { executeRun } from "./run-execution.ts";
import { latestRuns } from "./run-list.ts";
import { RunLogs } from "./run-logs.ts";
import { settleAfterRestart } from "./run-recovery.ts";
import type { RunOutcome, RunSession, SetupRunner } from "./run-session.ts";
import { applyVerify, canCancel, failure, newRun, type VerifyEvent } from "./run-state.ts";
import { VerifyRuns } from "./run-store.ts";

export interface VerifyOptions {
  store: Store;
  git: VerifyGit;
  forge: VerifyForge;
  shell: CheckShell;
  setup: SetupRunner;
  /** Where run checkouts live: `<dataDir>/verify`. */
  root: string;
  now(): number;
  id(): string;
  /** A project's checkout and its configured check command; undefined once it is gone. */
  project(workspaceId: WorkspaceId): { path: string; checkCommand?: string } | undefined;
  fetchTimeoutMs?: number;
  /** Most runs waiting per project; one more is refused `busy`. */
  queueLimit?: number;
  /** How long to wait before asking GitHub again about a run a restart left merging. */
  recoveryRetryMs?: number;
  /** How long to wait before retrying a merge GitHub refused while it settles the one before. */
  mergeRetryMs?: number;
  log?(message: string, error: unknown): void;
}

type Refusal = NonNullable<VerifyResult["error"]>;
export type VerifyAnswer = { ok: true; run: VerifyRun } | { ok: false; error: Refusal };

interface Active {
  controller: AbortController;
  reason?: "cancel" | "shutdown";
  done: Promise<void>;
}

/**
 * Verify (ADR 0094): queues runs one at a time per project, drives each through the runner,
 * persists every change and tells subscribers. A restart settles what the last daemon left.
 */
export class Verify {
  private readonly options: VerifyOptions;
  private readonly runs: VerifyRuns;
  private readonly logs: RunLogs;
  private readonly trees: CheckTrees;
  private readonly listeners = new Set<(change: VerifyChanged) => void>();
  private readonly queues = new Map<WorkspaceId, string[]>();
  private readonly busy = new Set<WorkspaceId>();
  private readonly active = new Map<string, Active>();
  private readonly allowed = new Map<string, () => boolean>();
  private readonly lifetime = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private recovery: Promise<void> = Promise.resolve();

  constructor(options: VerifyOptions) {
    this.options = options;
    this.runs = new VerifyRuns(options.store);
    this.logs = new RunLogs(this.runs);
    this.trees = new CheckTrees(options.git, this.runs, options.root);
  }

  subscribe(listener: (change: VerifyChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Settle what the previous daemon left: runs, then their checkouts, then merges in doubt. */
  recover(): Promise<void> {
    const merging: VerifyRun[] = [];
    for (const run of this.runs.live()) {
      if (this.active.has(run.id) || this.allowed.has(run.id)) continue;
      if (run.state === "merging") merging.push(run);
      else this.apply(run, settleAfterRestart(run, undefined));
    }
    this.recovery = (async () => {
      await this.trees
        .sweep((runId) => this.active.has(runId))
        .catch((error: unknown) => {
          this.options.log?.("Verify could not remove a left-over checkout", error);
        });
      await Promise.all(merging.map((run) => this.settleMerging(run, 0)));
    })();
    return this.recovery;
  }

  async list(
    workspaceId: WorkspaceId,
  ): Promise<
    { ok: true; runs: VerifyRun[]; command: string | null } | { ok: false; error: Refusal }
  > {
    const project = this.options.project(workspaceId);
    if (!project) return { ok: false, error: "not_found" };
    const command = await resolveCheckCommand(project.path, project.checkCommand);
    return { ok: true, runs: latestRuns(this.runs.list(workspaceId)), command };
  }

  log(runId: string): ForgeCheckLog | undefined {
    return this.runs.get(runId) ? checkLog(this.logs.read(runId)) : undefined;
  }

  async start(
    workspaceId: WorkspaceId,
    target: VerifyTarget,
    allowed: () => boolean,
  ): Promise<VerifyAnswer> {
    if (this.lifetime.signal.aborted) return { ok: false, error: "unavailable" };
    const project = this.options.project(workspaceId);
    if (!project) return { ok: false, error: "not_found" };
    if (target.kind === "merge") {
      const refusal = await this.mergeRefusal(project.path, workspaceId, target);
      if (refusal) return { ok: false, error: refusal };
    }
    const command = await resolveCheckCommand(project.path, project.checkCommand);
    if (command === null) return { ok: false, error: "no_command" };
    const queue = this.queues.get(workspaceId) ?? [];
    if (queue.length >= (this.options.queueLimit ?? 20)) return { ok: false, error: "busy" };
    const run = newRun({
      id: this.options.id(),
      workspaceId,
      target,
      command,
      at: this.options.now(),
    });
    this.runs.save(run);
    this.emit(run);
    this.allowed.set(run.id, allowed);
    queue.push(run.id);
    this.queues.set(workspaceId, queue);
    this.pump(workspaceId);
    return { ok: true, run: this.runs.get(run.id) ?? run };
  }

  /** Stop a queued or running run; it settles `cancelled` before this answers. */
  async cancel(runId: string): Promise<VerifyAnswer> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: "not_found" };
    if (!canCancel(run)) return { ok: false, error: "settled" };
    const active = this.active.get(runId);
    if (active) {
      active.reason ??= "cancel";
      active.controller.abort(new Error("Cancelled"));
      await active.done;
    } else {
      const queue = this.queues.get(run.workspaceId) ?? [];
      this.queues.set(
        run.workspaceId,
        queue.filter((id) => id !== runId),
      );
      this.allowed.delete(runId);
      this.apply(run, [{ type: "settle", state: "cancelled" }]);
    }
    const now = this.runs.get(runId) ?? run;
    return now.state === "merging" || now.state === "merged"
      ? { ok: false, error: "settled" }
      : { ok: true, run: now };
  }

  /** Stop every run: queued ones settle `interrupted`, running ones are stopped and settle so. */
  async close(): Promise<void> {
    this.lifetime.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [workspaceId, queue] of this.queues) {
      for (const id of queue) {
        const run = this.runs.get(id);
        if (run) this.apply(run, [{ type: "settle", state: "interrupted" }]);
      }
      this.queues.set(workspaceId, []);
    }
    for (const active of this.active.values()) {
      active.reason ??= "shutdown";
      active.controller.abort(new Error("Shutting down"));
    }
    await Promise.all([...this.active.values()].map((active) => active.done));
    await this.recovery.catch(() => {});
    this.logs.close();
  }

  /** Merge runs take PRs of one repository, once each, none in a GitHub stack. */
  private async mergeRefusal(
    path: string,
    workspaceId: WorkspaceId,
    target: Extract<VerifyTarget, { kind: "merge" }>,
  ): Promise<Refusal | undefined> {
    const numbers = target.prs.map((entry) => entry.pr.number);
    const first = target.prs[0]?.pr.repository;
    if (!first || new Set(numbers).size !== numbers.length) return "invalid";
    const same = target.prs.every(
      ({ pr }) =>
        pr.repository.host === first.host &&
        pr.repository.owner.toLowerCase() === first.owner.toLowerCase() &&
        pr.repository.name.toLowerCase() === first.name.toLowerCase(),
    );
    if (!same) return "invalid";
    try {
      const stacked = await this.options.forge.stacked(
        path,
        workspaceId,
        first,
        numbers,
        this.lifetime.signal,
      );
      return stacked.length ? "invalid" : undefined;
    } catch {
      return "unavailable";
    }
  }

  private pump(workspaceId: WorkspaceId): void {
    if (this.busy.has(workspaceId) || this.lifetime.signal.aborted) return;
    const queue = this.queues.get(workspaceId) ?? [];
    const next = queue.shift();
    if (next === undefined) return;
    this.busy.add(workspaceId);
    const controller = new AbortController();
    const active: Active = { controller, done: Promise.resolve() };
    this.active.set(next, active);
    active.done = this.execute(next, active)
      .catch((error: unknown) => this.options.log?.("Verify run failed", error))
      .finally(() => {
        this.active.delete(next);
        this.allowed.delete(next);
        this.busy.delete(workspaceId);
        this.pump(workspaceId);
      });
  }

  private async execute(runId: string, active: Active): Promise<void> {
    const stored = this.runs.get(runId);
    if (!stored || stored.state !== "queued") return;
    let current = this.apply(stored, [{ type: "start" }]);
    const project = this.options.project(stored.workspaceId);
    if (!project) {
      this.apply(current, [
        {
          type: "settle",
          state: "interrupted",
          failure: failure("unavailable", "The project was removed"),
        },
      ]);
      return;
    }
    const session: RunSession = {
      current: () => current,
      project: project.path,
      report: (event) => {
        current = this.apply(current, [event]);
      },
      line: (text) => this.logs.line(runId, text),
      signal: active.controller.signal,
      stopping: this.lifetime.signal,
      allowed: this.allowed.get(runId) ?? (() => false),
    };
    let outcome: RunOutcome;
    try {
      outcome = await executeRun(session, {
        git: this.options.git,
        forge: this.options.forge,
        trees: this.trees,
        shell: this.options.shell,
        setup: this.options.setup,
        fetchTimeoutMs: this.options.fetchTimeoutMs ?? 120_000,
        mergeRetryMs: this.options.mergeRetryMs ?? 3_000,
        pause,
      });
    } catch (error) {
      outcome = active.controller.signal.aborted
        ? { state: active.reason === "cancel" ? "cancelled" : "interrupted" }
        : {
            state: current.target.kind === "check" ? "failed" : "stopped",
            failure: failure("internal", describeError(error)),
          };
    }
    this.logs.finish(runId);
    if (outcome.state !== "merging") this.apply(current, [{ type: "settle", ...outcome }]);
  }

  /** Ask GitHub which PRs of a run left merging did merge; retry a few times if it can't say. */
  private async settleMerging(run: VerifyRun, attempt: number): Promise<void> {
    const project = this.options.project(run.workspaceId);
    const target = run.target;
    if (!project || target.kind !== "merge") {
      this.apply(run, [
        {
          type: "settle",
          state: "stopped",
          failure: failure("unavailable", "The project was removed while merging"),
        },
      ]);
      return;
    }
    const repository = target.prs[0]?.pr.repository;
    let merged: number[];
    try {
      if (!repository) throw new Error("No pull requests");
      merged = await this.options.forge.merged(
        project.path,
        repository,
        target.prs.map((entry) => entry.pr.number),
        this.lifetime.signal,
      );
    } catch (error) {
      if (this.lifetime.signal.aborted || attempt >= 4) {
        this.options.log?.("Verify could not settle a run left merging", error);
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          resolve();
        }, this.options.recoveryRetryMs ?? 30_000);
        timer.unref?.();
        this.timers.add(timer);
        this.lifetime.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (this.lifetime.signal.aborted) return;
      return this.settleMerging(this.runs.get(run.id) ?? run, attempt + 1);
    }
    this.apply(run, settleAfterRestart(run, new Set(merged)));
  }

  /** Apply events in order, persisting and telling subscribers about each change. */
  private apply(run: VerifyRun, events: readonly VerifyEvent[]): VerifyRun {
    let current = run;
    for (const event of events) {
      const next = applyVerify(current, event, this.options.now());
      if (next === current) continue;
      this.runs.save(next);
      this.emit(next);
      current = next;
    }
    return current;
  }

  private emit(run: VerifyRun): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: "verify.changed", run });
      } catch {
        // One socket's failure never stops the others hearing it.
      }
    }
  }
}

/** A timer that ends early, quietly, when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
