import { ProviderInstallRequest, ProviderInstallProgress } from "@ace/protocol";
import { installer, installerCommands, installCommand } from "@ace/provider-kit/installers";
import type {
  ClientMessage,
  ServerMessage,
  ProviderInstallPlan,
  ProviderStatus,
  ProviderKind,
  InstallMethod,
  RegistryAgent,
} from "@ace/protocol";

export const fakeLatestVersions: Partial<Record<ProviderKind, string>> = {
  codex: "0.161.0",
  claude: "2.1.5",
  opencode: "1.4.3",
  pi: "0.31.1",
};

type Scenario = "success" | "failure" | "needs_admin" | "missing_prerequisite" | "download_only";
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
  methods: Partial<Record<ProviderKind, InstallMethod>> = {};
  private jobs = new Map<string, Job>();
  private subscribers = new Map<(message: ServerMessage) => void, string>();
  private sequence = 0;
  private rows: () => ProviderStatus[];
  private changed: (progress: ProviderInstallProgress) => void;
  private catalog: (id: string) => RegistryAgent | undefined;
  constructor(
    rows: () => ProviderStatus[],
    changed: (progress: ProviderInstallProgress) => void,
    catalog: (id: string) => RegistryAgent | undefined = () => undefined,
  ) {
    this.catalog = catalog;
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
      ...(succeeded && job.progress.action !== "uninstall"
        ? { version: job.progress.plan?.latestVersion }
        : {}),
      message: succeeded
        ? "CLI installation updated."
        : "The official installer failed. Try again.",
    });
  }
  private plan(
    input: Extract<ProviderInstallRequest, { provider: ProviderKind }>,
  ): ProviderInstallPlan {
    const row = this.rows().find((entry) => entry.provider === input.provider);
    const listed = input.acpAgentId ? this.catalog(input.acpAgentId) : undefined;
    const spec = installer(input.provider, input.agent);
    const registry = input.provider === "antigravity" || !!input.acpAgentId;
    const method =
      "method" in input
        ? input.method
        : (this.methods[input.provider] ??
          (registry ? "registry" : spec?.package ? "npm" : "brew"));
    const methods = [
      ...(registry ? ["registry" as const] : []),
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
    const unsupported = !commands.length && !registry;
    const scenario =
      listed && listed.availability !== "available"
        ? "download_only"
        : this.scenarios[input.provider];
    return {
      provider: input.provider,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.acpAgentId ? { acpAgentId: input.acpAgentId } : {}),
      action: input.action,
      status:
        scenario === "download_only"
          ? "manual"
          : scenario === "missing_prerequisite"
            ? "unavailable"
            : input.provider === "cursor"
              ? "sign_in"
              : manual
                ? "manual"
                : unsupported
                  ? "unavailable"
                  : "ready",
      ...(unsupported ? {} : { method }),
      ...(scenario === "missing_prerequisite"
        ? {
            prerequisite: { name: "Node.js", sourceUrl: "https://nodejs.org/en/download" },
            message:
              "Install Node.js from its official download. It includes npm. Then retry Install here.",
          }
        : {}),
      ...(scenario === "download_only"
        ? {
            downloadOnly: true as const,
            message:
              "The vendor has no installable distribution for this computer. Download it from the official website.",
          }
        : {}),
      methods,
      commands,
      ...(spec?.binary ? { verify: installCommand(spec.binary, ["--version"]) } : {}),
      sourceUrl:
        scenario === "download_only"
          ? (listed?.homepage ?? "https://antigravity.google/download")
          : (listed?.homepage ??
            spec?.sourceUrl ??
            "https://agentclientprotocol.com/get-started/agents"),
      needsAdmin: this.scenarios[input.provider] === "needs_admin",
      ...(row?.version ? { installedVersion: row.version } : {}),
      ...(registry ? { latestVersion: listed?.version ?? "1.3.0" } : {}),
      ...(fakeLatestVersions[input.provider]
        ? {
            latestVersion: fakeLatestVersions[input.provider],
            updateAvailable: row?.version !== fakeLatestVersions[input.provider],
          }
        : {}),
      ...(unsupported
        ? {
            message:
              input.provider === "cursor"
                ? "The SDK ships with ace. Sign in to Cursor."
                : (spec?.manual ??
                  "Follow the provider's official runtime installation instructions."),
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
          ...(input.acpAgentId ? { acpAgentId: input.acpAgentId } : {}),
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
