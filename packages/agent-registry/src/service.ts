import { join } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  RegistryRequest,
  type RegistryResult,
  type RegistryInstallProgress,
  type RegistryInstallation,
  type AcpIdentity,
} from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import { AgentCatalog } from "./catalog.ts";
import { buildInstallPlan, InstallPlanError, type InstallPlan } from "./plans.ts";
import {
  ExecutableDigests,
  LocalInventory,
  LocalInstallation,
  bindLocal,
  executableDigest,
  type DigestMemory,
  type LocalBinding,
} from "./inventory.ts";
import { CommittedWriteError } from "./files.ts";
import { UpdateApprovalRequired, agentLabel, type UpdateApproval } from "./approvals.ts";
import { executeInstall, type InstallRuntime } from "./install.ts";
import { PinnedExecutables } from "./pinned.ts";
import type { ProbeRunner } from "./version-probe.ts";
const StoredInstallations = z.array(LocalInstallation).max(512);
/** Why an approval was refused, in words the person can act on. */
class ApprovalRefused extends Error {}
const approvalReasons: ReadonlySet<string> = new Set([
  "The agent changed again; review the update again",
  "This update was already approved or replaced; review it again",
  "Nothing changed since approval",
  "Approved ACP installation unavailable",
  "Native bridge CLI changed or unavailable",
  "Registry busy",
]);
export type InventoryStorage = {
  load(): Promise<unknown>;
  /** Reject with CommittedWriteError if publication happened before a durability failure. */
  save(entries: readonly LocalInstallation[]): Promise<void>;
};
export type RegistryServiceOptions = {
  catalog: AgentCatalog;
  storage: InventoryStorage;
  /** Keeps launch digests across restarts, so a start does not hash every agent again. */
  digests?: DigestMemory;
  root: string;
  target: string;
  env: NodeJS.ProcessEnv;
  managers?: Partial<Record<"npm" | "uv", string>>;
  runtime?: Omit<InstallRuntime, "env">;
  /** The clock approvals and pending updates are stamped with. */
  now?: () => number;
  /**
   * ace's own store of approved single-file executables, which launches run instead of the
   * files the agent can rewrite. Without one, approved files run in place, hashed just before.
   */
  pinned?: string;
  /** Runs an approved executable's `--version` at its update's approval; the CLI probe by default. */
  probe?: ProbeRunner;
  /** The platform launches run on; the daemon's by default. */
  platform?: NodeJS.Platform;
  /**
   * Called once an approved update is stored, with the installation as it runs now (its
   * version, profile revision and `versionSource`), so the model catalog can redo its row.
   */
  onUpdateApproved?(installation: RegistryInstallation): void;
};
export class AgentRegistry {
  readonly catalog: AgentCatalog;
  readonly inventory: LocalInventory;
  readonly #options: RegistryServiceOptions;
  readonly #digests: ExecutableDigests;
  readonly #pins: PinnedExecutables | undefined;
  #plans = new Map<string, InstallPlan>();
  #intents = new Map<
    string,
    {
      digest: string;
      result: Promise<RegistryResult["result"]>;
      abort: AbortController;
      completed: boolean;
      committing: boolean;
    }
  >();
  #active = false;
  #progress: RegistryInstallProgress | undefined;
  #closed = false;
  #binding = false;
  private constructor(
    options: RegistryServiceOptions,
    entries: LocalInstallation[],
    digests: ExecutableDigests,
  ) {
    this.#options = options;
    this.#digests = digests;
    this.catalog = options.catalog;
    this.#pins = options.pinned
      ? new PinnedExecutables(options.pinned, digests, options.platform ?? process.platform)
      : undefined;
    this.inventory = new LocalInventory(entries, digests, options.now, {
      ...(this.#pins ? { pins: this.#pins } : {}),
      run: options.probe ?? probeOutput,
    });
  }
  static async open(options: RegistryServiceOptions): Promise<AgentRegistry> {
    const digests = new ExecutableDigests(undefined, options.digests);
    const [value] = await Promise.all([options.storage.load(), digests.recall()]);
    const entries = value === undefined ? [] : StoredInstallations.parse(value);
    return new AgentRegistry(options, entries, digests);
  }
  has(identity: AcpIdentity): boolean {
    return this.inventory.has(identity);
  }
  async resolve(identity: AcpIdentity, environment: NodeJS.ProcessEnv = this.#options.env) {
    if (this.#closed) throw new Error("Registry closed");
    try {
      return await this.inventory.resolve(identity, environment);
    } catch (error) {
      // The refusal names the agent as the person knows it.
      if (error instanceof UpdateApprovalRequired)
        throw new UpdateApprovalRequired(
          error.identity,
          this.catalog.entry(error.identity.acpAgentId)?.name ??
            agentLabel(error.identity.acpAgentId),
        );
      throw error;
    }
  }
  /** Local terminal login only; never invoke ACP authenticate or a bundled bridge CLI. */
  async resolveLogin(identity: AcpIdentity, environment: NodeJS.ProcessEnv = this.#options.env) {
    const plan = await this.resolve(identity, environment);
    const login = plan.profile?.login;
    if (!login) return undefined;
    const command =
      login.binary === "native"
        ? plan.env[plan.profile?.bridge === "claude" ? "CLAUDE_CODE_EXECUTABLE" : "CODEX_PATH"]
        : plan.command;
    if (!command) throw new Error("Approved login CLI unavailable");
    return { command, args: [...login.args], env: { ...plan.env } };
  }
  /** Owner-approved installed command binding. Resolves and hashes without executing it. */
  async bind(input: LocalBinding): Promise<{ durability?: "uncertain" }> {
    if (this.#closed || this.#binding || this.#active) throw new Error("Registry busy");
    this.#binding = true;
    try {
      const installation = await bindLocal(input, this.#options.env);
      if (this.#closed) throw new Error("Registry closed");
      const next = new LocalInventory(this.inventory.all());
      next.add(installation);
      let durability: "uncertain" | undefined;
      try {
        await this.#options.storage.save(next.all());
      } catch (error) {
        if (!(error instanceof CommittedWriteError)) throw error;
        durability = "uncertain";
      }
      this.inventory.add(installation);
      return durability ? { durability } : {};
    } finally {
      this.#binding = false;
    }
  }
  /**
   * The person approves an installation's changed files for its same identity, so its threads
   * keep running (ADR 0044 amendment). The socket admits only the person's devices.
   */
  async approveUpdate(
    identity: AcpIdentity,
    approval: UpdateApproval,
  ): Promise<{ installation: LocalInstallation; durability?: "uncertain" }> {
    if (this.#closed || this.#binding || this.#active) throw new Error("Registry busy");
    this.#binding = true;
    try {
      const installation = await this.inventory.approved(identity, approval, this.#options.env);
      if (this.#closed) throw new Error("Registry closed");
      const next = new LocalInventory(this.inventory.all());
      next.replace(installation);
      let durability: "uncertain" | undefined;
      try {
        await this.#options.storage.save(next.all());
      } catch (error) {
        if (!(error instanceof CommittedWriteError)) throw error;
        durability = "uncertain";
      }
      this.inventory.replace(installation);
      // Copies of files nothing runs any more go; a session still running one keeps its process.
      await this.#pins?.prune(this.inventory.digests());
      this.#options.onUpdateApproved?.(structuredClone(installation.metadata));
      return { installation, ...(durability ? { durability } : {}) };
    } finally {
      this.#binding = false;
    }
  }
  async handle(input: RegistryRequest): Promise<RegistryResult> {
    const request = RegistryRequest.parse(input);
    const reply = (result: RegistryResult["result"]): RegistryResult => ({
      type: "registry.result",
      requestId: request.requestId,
      result,
    });
    if (this.#closed) return reply({ ok: false, reason: "Registry closed" });
    try {
      switch (request.type) {
        case "registry.bind": {
          if (!request.acpAgentId.startsWith("local:"))
            return reply({ ok: false, reason: "Local commands require a local: agent identity" });
          const durability = await this.bind({
            acpAgentId: request.acpAgentId,
            installationId: request.installationId,
            instanceId: request.instanceId,
            version: request.version,
            command: request.command,
            args: request.args,
            ...(request.underlyingCommand ? { underlyingCommand: request.underlyingCommand } : {}),
          });
          const installation = this.inventory
            .list()
            .find((entry) => entry.installationId === request.installationId);
          if (!installation) throw new Error("Binding not persisted");
          return reply({ ok: true, installation, ...durability });
        }
        case "registry.approve-update": {
          const approved = await this.approveUpdate(request, {
            executableDigest: request.executableDigest,
            bridgeDigest: request.bridgeDigest,
            previousExecutableDigest: request.previousExecutableDigest,
            previousBridgeDigest: request.previousBridgeDigest,
            generation: request.generation,
          }).catch((error: unknown) => {
            throw new ApprovalRefused(
              error instanceof Error && approvalReasons.has(error.message)
                ? error.message
                : "Couldn't approve this update",
            );
          });
          return reply({
            ok: true,
            installation: approved.installation.metadata,
            ...(approved.durability ? { durability: approved.durability } : {}),
          });
        }
        case "registry.list":
          // The first page checks every agent against its approval (a stat each when unchanged).
          if (request.offset === 0) await this.inventory.review();
          return reply({
            ...this.catalog.list(request.offset, request.limit),
            installations: this.inventory.list(),
            updates: this.inventory.pending(),
            ...(this.#progress ? { activeInstall: { ...this.#progress } } : {}),
          });
        case "registry.refresh":
          await this.catalog.refresh();
          return reply({ ...this.catalog.list(), installations: this.inventory.list() });
        case "registry.install-plan": {
          const agent = this.catalog.entry(request.acpAgentId);
          const catalogDigest = this.catalog.contentDigest;
          if (!agent || !catalogDigest)
            return reply({
              ok: false,
              reason: "Refresh the registry before planning installation",
            });
          let manager =
            request.runtime === "binary"
              ? undefined
              : await findExecutable(
                  this.#options.managers?.[request.runtime] ?? request.runtime,
                  this.#options.env,
                );
          if (
            !manager &&
            request.runtime === "uv" &&
            !this.#options.managers?.uv &&
            this.#options.env.HOME
          )
            manager = await findExecutable(
              join(this.#options.env.HOME, ".local", "bin", "uv"),
              this.#options.env,
            );
          const plan = buildInstallPlan({
            acpAgentId: request.acpAgentId,
            source: this.catalog.source,
            catalogDigest,
            agent,
            target: this.#options.target,
            root: this.#options.root,
            runtime: request.runtime,
            ...(manager ? { manager, managerDigest: await executableDigest(manager) } : {}),
          });
          if (this.#plans.size >= 16) {
            const oldest = this.#plans.keys().next().value;
            if (oldest) this.#plans.delete(oldest);
          }
          this.#plans.set(plan.preview.digest, plan);
          return reply({ ok: true, plan: plan.preview });
        }
        case "registry.install-cancel": {
          const intent = this.#intents.get(request.intentId);
          const cancelled = !!intent && !intent.completed && !intent.committing;
          if (cancelled) intent.abort.abort();
          return reply({ ok: true, cancelled });
        }
        case "registry.install-intent": {
          const old = this.#intents.get(request.intentId);
          if (old)
            return reply(
              old.digest === request.digest
                ? await old.result
                : { ok: false, reason: "Intent identity already used for another plan" },
            );
          const plan = this.#plans.get(request.digest);
          if (!plan || plan.catalogDigest !== this.catalog.contentDigest)
            return reply({
              ok: false,
              reason: "Installation plan changed or expired; review a new plan",
            });
          if (this.#active || this.#binding)
            return reply({ ok: false, reason: "Another installation is active" });
          if (this.#intents.size >= 128)
            return reply({
              ok: false,
              reason: "Install intent capacity reached; restart after review",
            });
          this.#active = true;
          this.#progress = {
            intentId: request.intentId,
            digest: request.digest,
            phase: "preparing",
            receivedBytes: 0,
          };
          const abort = new AbortController();
          const timeout = setTimeout(() => abort.abort(), 300000);
          const result = (async (): Promise<RegistryResult["result"]> => {
            let installation: LocalInstallation | undefined;
            try {
              installation = await executeInstall(plan, abort.signal, {
                ...this.#options.runtime,
                env: this.#options.env,
                onProgress: (phase, receivedBytes) => {
                  this.#progress = {
                    intentId: request.intentId,
                    digest: request.digest,
                    phase,
                    receivedBytes,
                  };
                },
              });
              abort.signal.throwIfAborted();
              const next = new LocalInventory(this.inventory.all());
              next.add(installation);
              this.#progress = {
                intentId: request.intentId,
                digest: request.digest,
                phase: "persist",
                receivedBytes: 0,
              };
              // Commit is noncancellable: persistence may have published before resolving.
              const intent = this.#intents.get(request.intentId);
              if (!intent) throw new Error("Missing install intent");
              intent.committing = true;
              clearTimeout(timeout);
              await this.#options.storage.save(next.all());
              this.inventory.add(installation);
              return { ok: true, installation: installation.metadata };
            } catch (error) {
              if (installation && error instanceof CommittedWriteError) {
                this.inventory.add(installation);
                return { ok: true, installation: installation.metadata, durability: "uncertain" };
              }
              if (installation)
                await rm(plan.preview.destination, { recursive: true, force: true });
              // No raw package-manager output crosses the registry boundary.
              return {
                ok: false,
                reason: abort.signal.aborted
                  ? "Installation cancelled"
                  : "Installation failed; prior installations remain usable",
              };
            } finally {
              clearTimeout(timeout);
              this.#active = false;
              this.#progress = undefined;
              const intent = this.#intents.get(request.intentId);
              if (intent) intent.completed = true;
            }
          })();
          this.#intents.set(request.intentId, {
            digest: request.digest,
            abort,
            result,
            completed: false,
            committing: false,
          });
          return reply(await result);
        }
      }
    } catch (error) {
      return reply({
        ok: false,
        reason:
          error instanceof InstallPlanError || error instanceof ApprovalRefused
            ? error.message
            : "Registry operation unavailable or invalid",
      });
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const intent of this.#intents.values()) if (!intent.committing) intent.abort.abort();
    await Promise.all([...this.#intents.values()].map((intent) => intent.result));
    await this.catalog.close();
    await this.#digests.saved();
  }
}
