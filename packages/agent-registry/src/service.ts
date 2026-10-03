import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  RegistryRequest,
  type RegistryResult,
  type RegistryInstallProgress,
  type AcpIdentity,
} from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";
import { AgentCatalog } from "./catalog.ts";
import { buildInstallPlan, InstallPlanError, type InstallPlan } from "./plans.ts";
import {
  LocalInventory,
  LocalInstallation,
  bindLocal,
  executableDigest,
  type LocalBinding,
} from "./inventory.ts";
import { CommittedWriteError } from "./files.ts";
import { executeInstall, type InstallRuntime } from "./install.ts";
export type InventoryStorage = {
  load(): Promise<unknown>;
  /** Reject with CommittedWriteError if publication happened before a durability failure. */
  save(entries: readonly LocalInstallation[]): Promise<void>;
};
export type RegistryServiceOptions = {
  catalog: AgentCatalog;
  storage: InventoryStorage;
  root: string;
  target: string;
  env: NodeJS.ProcessEnv;
  managers?: Partial<Record<"npm" | "uv", string>>;
  runtime?: Omit<InstallRuntime, "env">;
};
export class AgentRegistry {
  readonly catalog: AgentCatalog;
  readonly inventory: LocalInventory;
  readonly #options: RegistryServiceOptions;
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
  private constructor(options: RegistryServiceOptions, entries: LocalInstallation[]) {
    this.#options = options;
    this.catalog = options.catalog;
    this.inventory = new LocalInventory(entries);
  }
  static async open(options: RegistryServiceOptions): Promise<AgentRegistry> {
    const value = await options.storage.load();
    const entries = value === undefined ? [] : z.array(LocalInstallation).max(512).parse(value);
    return new AgentRegistry(options, entries);
  }
  has(identity: AcpIdentity): boolean {
    return this.inventory.has(identity);
  }
  resolve(identity: AcpIdentity, environment: NodeJS.ProcessEnv = this.#options.env) {
    if (this.#closed) throw new Error("Registry closed");
    return this.inventory.resolve(identity, environment);
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
        case "registry.list":
          return reply({
            ...this.catalog.list(request.offset, request.limit),
            installations: this.inventory.list(),
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
          const manager =
            request.runtime === "binary"
              ? undefined
              : await findExecutable(
                  this.#options.managers?.[request.runtime] ?? request.runtime,
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
          error instanceof InstallPlanError
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
  }
}
