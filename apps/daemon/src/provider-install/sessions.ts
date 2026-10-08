import { stripVTControlCharacters } from "node:util";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { createTextRedactor } from "@ace/redaction";
import type {
  ProviderInstallRequest,
  ProviderInstallResult,
  ProviderInstallProgress,
  ProviderInstallPlan,
} from "@ace/protocol";
import { InstallPlanner, type InstallEnvironment, type InstallTarget } from "./planner.ts";
import { InstallVersions } from "./versions.ts";

export interface InstallRuntime {
  now(): number;
  id(): string;
  schedule(callback: () => void, ms: number): () => void;
  changed(plan: ProviderInstallPlan, version?: string): Promise<void>;
  log(command: string): void;
  spawn?: typeof spawnSupervised;
}
interface Job {
  owner: string;
  requestId: string;
  progress: ProviderInstallProgress;
  abort: AbortController;
  process?: SupervisedProcess;
  done?: Promise<void>;
  flush?: () => void;
}
const terminal = (state: ProviderInstallProgress["state"]) =>
  ["succeeded", "failed", "cancelled", "needs_admin"].includes(state);
/** Ephemeral sessions survive socket reconnects, retain bounded history, and own every process. */
export class ProviderInstalls {
  readonly planner: InstallPlanner;
  readonly versions: InstallVersions;
  private jobs = new Map<string, Job>();
  private listeners = new Set<(owner: string, progress: ProviderInstallProgress) => void>();
  private runtime: InstallRuntime;
  private redact: (line: string) => string;
  private plans = new Set<Promise<ProviderInstallPlan>>();
  private closed = false;
  private controller = new AbortController();
  constructor(environment: InstallEnvironment, runtime: InstallRuntime) {
    this.planner = new InstallPlanner(environment);
    this.runtime = runtime;
    this.versions = new InstallVersions(this.planner, runtime.now);
    this.redact = createTextRedactor({ env: environment.env });
  }
  listen(listener: (owner: string, progress: ProviderInstallProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async plan(
    target: InstallTarget,
    action: ProviderInstallPlan["action"],
  ): Promise<ProviderInstallPlan> {
    const work = this.planner
      .plan(target, action, undefined, this.controller.signal)
      .then(async (plan) => ({
        ...plan,
        ...(await this.versions.check(plan, this.controller.signal)),
      }));
    this.plans.add(work);
    try {
      return await work;
    } finally {
      this.plans.delete(work);
    }
  }
  async handle(owner: string, request: ProviderInstallRequest): Promise<ProviderInstallResult> {
    const reply = (result: ProviderInstallResult["result"]): ProviderInstallResult => ({
      type: "provider.install.result",
      requestId: request.requestId,
      result,
    });
    if (this.closed) return reply({ ok: false, error: "unavailable" });
    if (request.type === "provider.install.plan")
      return reply({ ok: true, plan: await this.plan(request, request.action) });
    if (request.type === "provider.install.run") {
      const retry = [...this.jobs.values()].find(
        (job) => job.owner === owner && job.requestId === request.requestId,
      );
      if (retry) return reply({ ok: true, progress: retry.progress });
      if (
        [...this.jobs.values()].some(
          (job) => job.progress.provider === request.provider && !terminal(job.progress.state),
        )
      )
        return reply({ ok: false, error: "busy" });
      while (this.jobs.size >= 32) {
        const oldest = [...this.jobs.values()].find((job) => terminal(job.progress.state));
        if (!oldest) return reply({ ok: false, error: "busy" });
        this.jobs.delete(oldest.progress.session);
      }
      const job: Job = {
        owner,
        requestId: request.requestId,
        abort: new AbortController(),
        progress: {
          session: this.runtime.id(),
          provider: request.provider,
          ...(request.agent ? { agent: request.agent } : {}),
          action: request.action,
          method: request.method,
          state: "planning",
          sequence: 0,
          step: 0,
          lines: [],
        },
      };
      this.jobs.set(job.progress.session, job);
      // Admission is synchronous, before asynchronous planning, so simultaneous runs cannot race.
      job.done = this.run(job);
      return reply({ ok: true, progress: job.progress });
    }
    const job = this.jobs.get(request.session);
    if (!job) return reply({ ok: false, error: "not_found" });
    if (job.owner !== owner) return reply({ ok: false, error: "forbidden" });
    if (request.type === "provider.install.cancel" && !terminal(job.progress.state)) {
      job.abort.abort();
      await job.process?.stop({ graceMs: 0 });
      await job.done;
    }
    return reply({ ok: true, progress: job.progress });
  }
  private publish(job: Job, update: Partial<ProviderInstallProgress> = {}): void {
    job.flush?.();
    delete job.flush;
    job.progress = {
      ...job.progress,
      ...update,
      sequence: job.progress.sequence + 1,
      lines: [...job.progress.lines],
    };
    for (const listener of this.listeners) listener(job.owner, job.progress);
  }
  private line(job: Job, text: string): void {
    // Strip terminal control bytes before publishing installer output.
    // eslint-disable-next-line no-control-regex
    const safe = this.redact(stripVTControlCharacters(text)).replace(/[\x00-\x1f\x7f]/g, "");
    const line = safe.length > 2048 ? `${safe.slice(0, 2036)} [truncated]` : safe;
    job.progress = { ...job.progress, lines: [...job.progress.lines.slice(-99), line] };
    if (!job.flush) job.flush = this.runtime.schedule(() => this.publish(job), 50);
  }
  private async run(job: Job): Promise<void> {
    const cancelDeadline = this.runtime.schedule(() => {
      job.abort.abort();
      void job.process?.stop({ graceMs: 0 });
    }, 900_000);
    try {
      const plan = await this.planner.plan(
        job.progress,
        job.progress.action,
        job.progress.method,
        job.abort.signal,
      );
      if (job.abort.signal.aborted) return;
      if (plan.status !== "ready") {
        this.publish(job, {
          plan,
          state: "failed",
          message: plan.message ?? "Installation method unavailable.",
        });
        return;
      }
      if (plan.needsAdmin) {
        this.publish(job, { plan, state: "needs_admin", message: plan.message });
        return;
      }
      this.publish(job, { plan, state: "running" });
      for (const [index, command] of plan.commands.entries()) {
        if (job.abort.signal.aborted) return;
        this.publish(job, { step: index });
        this.line(job, command.display);
        this.runtime.log(command.display);
        const proc = (this.runtime.spawn ?? spawnSupervised)({
          command: command.command,
          args: command.args,
          env: this.planner.env,
          name: "provider-installer",
          maxLineBytes: 65536,
          maxOutputBytes: 16 * 1024 * 1024,
        });
        job.process = proc;
        proc.stdout.on("line", (line: string) => this.line(job, line));
        proc.stderr.on("line", (line: string) => this.line(job, line));
        proc.stdin.end();
        const exit = await proc.exited;
        delete job.process;
        if (job.abort.signal.aborted) return;
        if (exit.code !== 0 || exit.reason !== "exit") {
          this.publish(job, {
            state: "failed",
            exit: exit.code,
            message: "Installer failed. Review the sanitized log and retry.",
          });
          return;
        }
      }
      this.publish(job, { state: "verifying", step: plan.commands.length, exit: 0 });
      const version = await this.planner.verify(plan, job.abort.signal);
      if (job.abort.signal.aborted) return;
      if (!version) {
        this.publish(job, {
          state: "failed",
          message:
            plan.action === "uninstall"
              ? "The binary is still installed. Check for another installation."
              : "The installed binary did not pass --version verification.",
        });
        return;
      }
      this.versions.invalidate(plan);
      this.runtime.log(`${plan.provider}${plan.agent ? `/${plan.agent}` : ""}: ${version}`);
      await this.runtime.changed(plan, version === "removed" ? undefined : version);
      if (!job.abort.signal.aborted)
        this.publish(job, { state: "succeeded", ...(version === "removed" ? {} : { version }) });
    } catch {
      if (!job.abort.signal.aborted)
        this.publish(job, {
          state: "failed",
          message:
            "Installer or discovery refresh failed. Check provider readiness before retrying.",
        });
    } finally {
      cancelDeadline();
      await job.process?.stop({ graceMs: 0 });
      delete job.process;
      if (job.abort.signal.aborted)
        this.publish(job, {
          state: "cancelled",
          message: "Installation cancelled. Partial changes may remain; check readiness.",
        });
      job.flush?.();
      delete job.flush;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    for (const job of this.jobs.values())
      if (!terminal(job.progress.state)) {
        job.abort.abort();
        void job.process?.stop({ graceMs: 0 });
      }
    await Promise.allSettled(this.plans);
    await Promise.all([...this.jobs.values()].map((job) => job.done));
    this.listeners.clear();
    this.jobs.clear();
  }
}
