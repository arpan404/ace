import type {
  ClientMessage,
  RegistryInstallation,
  RegistryInstallPlan,
  RegistryInstallProgress,
  RegistryResult,
  ServerMessage,
} from "@ace/protocol";
import { registryFixture, type FakeRegistryEntry } from "../catalog/acp-registry.ts";

type Push = (message: ServerMessage) => void;
type Result = RegistryResult["result"];
type Runtime = RegistryInstallPlan["runtime"];

export interface FakeRegistryHost {
  /** Wall-clock time: `fetchedAt` is a fact the client compares with its own clock. */
  now(): number;
  schedule(callback: () => void, delayMs: number): void;
}

const source = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const root = "/Users/ada/.ace-next/agent-registry/installations";
const managers: Record<Exclude<Runtime, "binary">, string> = {
  npm: "/opt/homebrew/bin/npm",
  uv: "/opt/homebrew/bin/uv",
};
const ttl = 86_400_000;

/** A 64-hex digest of `text`, deterministic and browser-safe (FNV-1a over eight seeds). */
function digest(text: string): string {
  let out = "";
  for (let seed = 0; seed < 8; seed++) {
    let hash = 0x811c9dc5 ^ seed;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

interface Intent {
  digest: string;
  result: Result | undefined;
  waiting: ((result: Result) => void)[];
  cancelled: boolean;
}

/**
 * The daemon's ACP registry service (`registry.*`) over a fixture: the cached index pages,
 * refresh, install plans, install intents with progress, and cancel. Steps run on a timer so
 * dev:fake shows progress; with `stepMs = null` they wait for `step()`, so tests hold an install
 * mid-download. Tests stage what happens next through the public fields.
 */
export class FakeRegistry {
  entries: FakeRegistryEntry[] = registryFixture();
  installations: RegistryInstallation[];
  fetchedAt: number | undefined;
  /** What the next refresh finds upstream; undefined finds the same entries. */
  upstream: FakeRegistryEntry[] | undefined;
  /** The next refreshes can't reach the registry. */
  refreshFails = false;
  /** Commands `registry.bind` finds on this machine. */
  localCommands = new Set(["fake-acp"]);
  /** Package managers the fake machine doesn't have. */
  missingManagers = new Set<Exclude<Runtime, "binary">>();
  /** The next install fails with this daemon reason. */
  failInstall: string | undefined;
  /** Every install intent received, in order: what the person approved, by plan digest. */
  readonly intents: { intentId: string; digest: string }[] = [];
  /** Delay between simulated steps; null holds them until `step()`. */
  stepMs: number | null = 450;
  private host: FakeRegistryHost;
  private refreshing: Promise<void> | undefined;
  /** Every plan made, by digest: what the person reviewed. */
  readonly plans = new Map<
    string,
    { entry: FakeRegistryEntry; runtime: Runtime; plan: RegistryInstallPlan }
  >();
  private intentsById = new Map<string, Intent>();
  private active: RegistryInstallProgress | undefined;
  private held: (() => void)[] = [];
  private refreshed = false;
  constructor(host: FakeRegistryHost) {
    this.host = host;
    const now = host.now();
    this.fetchedAt = now - 5 * 60_000;
    this.installations = [
      {
        acpAgentId: "official:gemini",
        installationId: digest("gemini@0.62.0"),
        instanceId: `${digest("gemini@0.62.0")}:default`,
        version: "0.62.0",
        profileRevision: "generic-v1",
        source,
        evidence: "package_manager",
        packageManager: {
          command: managers.npm,
          package: "@google/gemini-cli@0.62.0",
          integrity: "sha512-fixture",
        },
      },
    ];
  }
  /** Runs the next held step; false when none is waiting. */
  step(): boolean {
    const next = this.held.shift();
    next?.();
    return next !== undefined;
  }
  /** Answers a `registry.*` request; false for any other message. */
  handle(message: ClientMessage, push: Push): boolean {
    const reply = (requestId: string) => (result: Result) =>
      push({ type: "registry.result", requestId, result });
    switch (message.type) {
      case "registry.list":
        reply(message.requestId)(this.list(message.offset, message.limit));
        return true;
      case "registry.refresh":
        void this.refresh().then(() => reply(message.requestId)(this.list(0, 50)));
        return true;
      case "registry.bind":
        reply(message.requestId)(this.bind(message));
        return true;
      case "registry.install-plan":
        reply(message.requestId)(this.plan(message.acpAgentId, message.runtime));
        return true;
      case "registry.install-intent":
        this.install(message.intentId, message.digest, reply(message.requestId));
        return true;
      case "registry.install-cancel": {
        const intent = this.intentsById.get(message.intentId);
        const cancellable =
          !!intent && intent.result === undefined && this.active?.phase !== "persist";
        if (intent && cancellable) {
          intent.cancelled = true;
          this.finish(intent, { ok: false, reason: "Installation cancelled" });
        }
        reply(message.requestId)({ ok: true, cancelled: cancellable });
        return true;
      }
      default:
        return false;
    }
  }
  /** An owner-approved local command (`local:` ids only, commands this machine has). */
  private bind(message: Extract<ClientMessage, { type: "registry.bind" }>): Result {
    if (
      !message.acpAgentId.startsWith("local:") ||
      !this.localCommands.has(message.command) ||
      this.installations.some((entry) => entry.installationId === message.installationId)
    )
      return { ok: false, reason: "Registry operation unavailable or invalid" };
    const installation: RegistryInstallation = {
      acpAgentId: message.acpAgentId,
      installationId: message.installationId,
      instanceId: message.instanceId,
      version: message.version,
      source: "user-local",
      profileRevision: "generic-v1",
      evidence: "user_local_binding",
    };
    this.installations = [...this.installations, installation];
    return { ok: true, installation };
  }
  private later(callback: () => void): void {
    if (this.stepMs === null) this.held.push(callback);
    else this.host.schedule(callback, this.stepMs);
  }
  private get contentDigest(): string {
    return digest(JSON.stringify(this.entries.map((entry) => entry.agent)));
  }
  private list(offset: number, limit: number): Result {
    const agents = this.entries.slice(offset, offset + limit).map((entry) => entry.agent);
    return {
      ok: true,
      agents,
      installations: this.installations,
      stale: this.fetchedAt === undefined || this.host.now() - this.fetchedAt >= ttl,
      refreshing: this.refreshing !== undefined,
      source,
      ...(this.fetchedAt === undefined
        ? {}
        : { fetchedAt: this.fetchedAt, digest: this.contentDigest, schemaVersion: "1.0.0" }),
      ...(this.refreshFails && this.refreshed ? { error: "refresh_failed" as const } : {}),
      ...(this.active ? { activeInstall: { ...this.active } } : {}),
      ...(this.entries.length > offset + limit ? { nextOffset: offset + limit } : {}),
    };
  }
  private refresh(): Promise<void> {
    this.refreshing ??= new Promise<void>((resolve) =>
      this.later(() => {
        this.refreshed = true;
        if (!this.refreshFails) {
          if (this.upstream) this.entries = this.upstream;
          this.upstream = undefined;
          this.fetchedAt = this.host.now();
        }
        this.refreshing = undefined;
        resolve();
      }),
    );
    return this.refreshing;
  }
  private plan(acpAgentId: string, runtime: Runtime): Result {
    const entry = this.entries.find((candidate) => candidate.agent.acpAgentId === acpAgentId);
    if (!entry) return { ok: false, reason: "Refresh the registry before planning installation" };
    const { agent, distribution } = entry;
    if (agent.availability !== "available" || !agent.runtimes?.includes(runtime))
      return {
        ok: false,
        reason:
          runtime === "binary" ? "Binary target unavailable" : "Package distribution unavailable",
      };
    if (runtime !== "binary" && this.missingManagers.has(runtime))
      return { ok: false, reason: "Select a local package manager" };
    const planDigest = digest(`${this.contentDigest}:${acpAgentId}:${agent.version}:${runtime}`);
    const destination = `${root}/${planDigest}`;
    const binary = distribution.binary;
    const argv =
      runtime === "binary" && binary
        ? [binary.archive, binary.cmd, ...(binary.args ?? [])]
        : runtime === "npm"
          ? [
              managers.npm,
              "install",
              "--prefix",
              destination,
              "--no-audit",
              "--no-fund",
              "--save-exact",
              "--",
              distribution.npm ?? "",
            ]
          : [managers.uv, "tool", "install", "--no-progress", "--", distribution.uv ?? ""];
    const plan: RegistryInstallPlan = {
      digest: planDigest,
      acpAgentId,
      version: agent.version,
      source,
      publisher: agent.authors,
      runtime,
      target: "darwin-aarch64",
      destination,
      argv,
      verification:
        runtime === "binary" ? (binary?.sha256 ? "sha256" : "unsigned_https") : "package_manager",
    };
    this.plans.set(planDigest, { entry, runtime, plan });
    return { ok: true, plan };
  }
  private install(intentId: string, planDigest: string, reply: (result: Result) => void): void {
    const known = this.intentsById.get(intentId);
    if (known) {
      if (known.digest !== planDigest)
        reply({ ok: false, reason: "Intent identity already used for another plan" });
      else if (known.result) reply(known.result);
      else known.waiting.push(reply);
      return;
    }
    const planned = this.plans.get(planDigest);
    if (!planned || !this.current(planned.plan)) {
      reply({ ok: false, reason: "Installation plan changed or expired; review a new plan" });
      return;
    }
    if (this.active) {
      reply({ ok: false, reason: "Another installation is active" });
      return;
    }
    const intent: Intent = {
      digest: planDigest,
      result: undefined,
      waiting: [reply],
      cancelled: false,
    };
    this.intentsById.set(intentId, intent);
    this.intents.push({ intentId, digest: planDigest });
    const size = planned.entry.size ?? 24_000_000;
    const phases: Omit<RegistryInstallProgress, "intentId" | "digest">[] =
      planned.runtime === "binary"
        ? [
            { phase: "preparing", receivedBytes: 0 },
            ...[0.18, 0.46, 0.74, 1].map((part) => ({
              phase: "download" as const,
              receivedBytes: Math.round(size * part),
            })),
            { phase: "extract", receivedBytes: size },
            { phase: "persist", receivedBytes: 0 },
          ]
        : [
            { phase: "preparing", receivedBytes: 0 },
            { phase: "package_manager", receivedBytes: 0 },
            { phase: "package_manager", receivedBytes: 0 },
            { phase: "persist", receivedBytes: 0 },
          ];
    const failure = this.failInstall;
    this.failInstall = undefined;
    const advance = (index: number) => {
      if (intent.cancelled) return;
      const phase = phases[index];
      if (!phase) {
        this.finish(
          intent,
          failure
            ? { ok: false, reason: failure }
            : { ok: true, installation: this.installed(planned.plan) },
        );
        return;
      }
      this.active = { intentId, digest: planDigest, ...phase };
      this.later(() => advance(index + 1));
    };
    advance(0);
  }
  private current(plan: RegistryInstallPlan): boolean {
    const entry = this.entries.find((candidate) => candidate.agent.acpAgentId === plan.acpAgentId);
    return entry?.agent.version === plan.version;
  }
  private installed(plan: RegistryInstallPlan): RegistryInstallation {
    const installation: RegistryInstallation = {
      acpAgentId: plan.acpAgentId,
      installationId: plan.digest,
      instanceId: `${plan.digest}:default`,
      version: plan.version,
      profileRevision: "generic-v1",
      source,
      evidence: plan.runtime === "binary" ? "sha256" : "package_manager",
      ...(plan.runtime === "binary"
        ? {}
        : {
            packageManager: {
              command: plan.argv[0] ?? "",
              package: plan.argv.at(-1) ?? "",
              ...(plan.runtime === "npm" ? { integrity: "sha512-fixture" } : {}),
            },
          }),
    };
    this.installations = [...this.installations, installation];
    return installation;
  }
  private finish(intent: Intent, result: Result): void {
    this.active = undefined;
    intent.result = result;
    for (const reply of intent.waiting.splice(0)) reply(result);
  }
}
