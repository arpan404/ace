import { ProviderInstallRequest, ProviderInstallProgress } from "@ace/protocol";
import { installer, installerCommands, installCommand } from "@ace/provider-kit/installers";
import type {
  ClientMessage,
  ServerMessage,
  ProviderInstallPlan,
  ProviderStatus,
  ProviderKind,
} from "@ace/protocol";

type Scenario = "success" | "failure" | "needs_admin";
interface Job {
  requestId: string;
  owner: string;
  progress: ProviderInstallProgress;
}
const done = (state: string) => ["succeeded", "failed", "cancelled", "needs_admin"].includes(state);
/** Explicit completion and progress injection let UI tests exercise every state without timers. */
export class FakeProviderInstalls {
  scenarios: Partial<Record<ProviderKind, Scenario>> = {};
  autoComplete = true;
  private jobs = new Map<string, Job>();
  private subscribers = new Map<(message: ServerMessage) => void, string>();
  private sequence = 0;
  private rows: () => ProviderStatus[];
  private changed: (progress: ProviderInstallProgress) => void;
  constructor(rows: () => ProviderStatus[], changed: (progress: ProviderInstallProgress) => void) {
    this.rows = rows;
    this.changed = changed;
  }
  release(push: (message: ServerMessage) => void): void {
    this.subscribers.delete(push);
  }
  private publish(job: Job, update: Partial<ProviderInstallProgress>): void {
    job.progress = ProviderInstallProgress.parse({
      ...job.progress,
      ...update,
      sequence: job.progress.sequence + 1,
    });
    for (const [push, owner] of this.subscribers)
      if (owner === job.owner) push({ type: "provider.install.progress", progress: job.progress });
  }
  advance(session: string, line = "Downloading official package…"): void {
    const job = this.jobs.get(session);
    if (job && !done(job.progress.state))
      this.publish(job, { lines: [...job.progress.lines.slice(-99), line.slice(0, 2048)] });
  }
  complete(session: string, success = true): void {
    const job = this.jobs.get(session);
    if (!job || done(job.progress.state)) return;
    this.publish(job, { state: "verifying" });
    const succeeded = success && this.scenarios[job.progress.provider] !== "failure";
    if (succeeded) this.changed(job.progress);
    this.publish(job, {
      state: succeeded ? "succeeded" : "failed",
      exit: succeeded ? 0 : 1,
      ...(succeeded && job.progress.action !== "uninstall" ? { version: "9.0.0" } : {}),
      message: succeeded
        ? "CLI installation updated."
        : "The official installer failed. Try again.",
    });
  }
  private plan(
    input: Extract<ProviderInstallRequest, { provider: ProviderKind }>,
  ): ProviderInstallPlan {
    const row = this.rows().find((entry) => entry.provider === input.provider);
    const spec = installer(input.provider, input.agent);
    const method = "method" in input ? input.method : spec?.package ? "npm" : "brew";
    const methods = [
      ...(spec?.package ? ["npm" as const] : []),
      ...(spec?.bun ? ["bun" as const] : []),
      ...(spec?.brew ? ["brew" as const] : []),
      ...(spec?.script ? ["script" as const] : []),
    ];
    const commands =
      spec && !spec.manual
        ? installerCommands(
            spec,
            input.action,
            method,
            {
              npm: "npm",
              bun: "bun",
              brew: "brew",
              curl: "curl",
              bash: "bash",
              rm: "rm",
            },
            "/fake/home",
          )
        : [];
    const manual = Boolean(
      spec?.manual ||
      (method === "script" && input.action === "uninstall" && !spec?.scriptUninstall),
    );
    const unsupported = !commands.length;
    return {
      provider: input.provider,
      ...(input.agent ? { agent: input.agent } : {}),
      action: input.action,
      status:
        input.provider === "cursor"
          ? "sign_in"
          : manual
            ? "manual"
            : unsupported
              ? "unavailable"
              : "ready",
      ...(unsupported ? {} : { method }),
      methods,
      commands,
      ...(spec?.binary ? { verify: installCommand(spec.binary, ["--version"]) } : {}),
      sourceUrl: spec?.sourceUrl ?? "https://agentclientprotocol.com/get-started/agents",
      needsAdmin: this.scenarios[input.provider] === "needs_admin",
      ...(row?.version
        ? {
            installedVersion: row.version,
            latestVersion: "9.0.0",
            updateAvailable: row.version !== "9.0.0",
          }
        : {}),
      ...(unsupported
        ? {
            message:
              input.provider === "cursor"
                ? "The SDK ships with ace. Sign in to Cursor."
                : "Follow the provider's official runtime installation instructions.",
          }
        : {}),
    };
  }
  handle(message: ClientMessage, owner: string, push: (message: ServerMessage) => void): boolean {
    const parsed = ProviderInstallRequest.safeParse(message);
    if (!parsed.success) return false;
    const input = parsed.data;
    this.subscribers.set(push, owner);
    const reply = (result: import("@ace/protocol").ProviderInstallResult["result"]) =>
      push({ type: "provider.install.result", requestId: input.requestId, result });
    if (input.type === "provider.install.plan") {
      reply({ ok: true, plan: this.plan(input) });
      return true;
    }
    if (input.type === "provider.install.run") {
      const retry = [...this.jobs.values()].find(
        (job) => job.owner === owner && job.requestId === input.requestId,
      );
      if (retry) {
        reply({ ok: true, progress: retry.progress });
        return true;
      }
      if (
        [...this.jobs.values()].some(
          (job) => job.progress.provider === input.provider && !done(job.progress.state),
        )
      ) {
        reply({ ok: false, error: "busy" });
        return true;
      }
      if (this.jobs.size >= 32) {
        const oldest = [...this.jobs.values()].find((job) => done(job.progress.state));
        if (!oldest) {
          reply({ ok: false, error: "busy" });
          return true;
        }
        this.jobs.delete(oldest.progress.session);
      }
      const plan = this.plan(input);
      const job: Job = {
        requestId: input.requestId,
        owner,
        progress: {
          session: `fake-install-${++this.sequence}`,
          provider: input.provider,
          ...(input.agent ? { agent: input.agent } : {}),
          action: input.action,
          method: input.method,
          state: plan.status !== "ready" ? "failed" : plan.needsAdmin ? "needs_admin" : "running",
          sequence: 0,
          step: 0,
          plan,
          lines: plan.commands.map((command) => command.display),
          ...(plan.message ? { message: plan.message } : {}),
        },
      };
      this.jobs.set(job.progress.session, job);
      reply({ ok: true, progress: job.progress });
      this.advance(job.progress.session);
      if (this.autoComplete) void Promise.resolve().then(() => this.complete(job.progress.session));
      return true;
    }
    const job = this.jobs.get(input.session);
    if (!job) reply({ ok: false, error: "not_found" });
    else if (job.owner !== owner) reply({ ok: false, error: "forbidden" });
    else {
      if (input.type === "provider.install.cancel" && !done(job.progress.state))
        this.publish(job, { state: "cancelled" });
      reply({ ok: true, progress: job.progress });
    }
    return true;
  }
}
