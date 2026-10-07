import { onboardingChecklist } from "@ace/core";
import { FakeProviderLogin, fakeReadiness } from "../provider-login.ts";
import { configuredModels, providerConfiguration } from "@ace/models/preferences";
import { ProviderConfigurations, ProviderKind } from "@ace/protocol";
import { AccountManagementRequest } from "@ace/protocol/accounts";
import { z } from "zod";
const zGroup = z.tuple([ProviderKind, z.string()]);
import type { AccountSummary as Summary } from "@ace/protocol/accounts";
import type { CatalogModel, ClientMessage, PaletteCommand, ServerMessage } from "@ace/protocol";
import { FakeUsage } from "../catalog/usage.ts";
import { modelCatalog, settingsValues } from "../scenarios/settings.ts";
import { accountSummaries } from "./accounts.ts";
import { commandCatalog, listCommands } from "./commands.ts";
import { search } from "./search.ts";
import { listModels, resolveModel } from "./models.ts";
import { FakeSettings, type Push } from "./settings.ts";
import { FakeActivityReads } from "./activity-reads.ts";
import { fakeProviderPermissions } from "../permissions.ts";

type AccountSummary = z.infer<typeof Summary>;

export interface ServiceHost {
  clock(): number;
  /** Sends to every authenticated connection, as the daemon's pushes do (none when absent). */
  broadcast?(message: ServerMessage): void;
  /** The thread's project and provider, or undefined when the thread doesn't exist. */
  thread(threadId: string): { workspaceId: string; provider: ProviderKind } | undefined;
}

/**
 * The daemon's catalog services (accounts, usage, models, settings, search, slash commands) over
 * the fake daemon's catalogs. Context, workspace, terminal, plugin, planning and browser services
 * are per-connection sessions in `services-wire.ts`. Replies use the wire shapes, so the app
 * reads them through `Client.request` exactly as it does from a real daemon. Tests change the
 * public fields to stage what the daemon reports next.
 */
export class FakeServices {
  readonly providerLogin: FakeProviderLogin;
  accounts: AccountSummary[];
  readonly authTerminals = new Map<
    string,
    { instanceId: string; action: "login" | "logout"; owner: Push; scope?: "operate" }
  >();
  private accountCounter = 0;
  models: CatalogModel[];
  providerStatuses: import("@ace/protocol").ProviderStatus[];
  commands: PaletteCommand[];
  /** Usage over time and Claude's per-session totals; replace its fields to stage a report. */
  readonly usage: FakeUsage;
  readonly settings: FakeSettings;
  /** Activity's read cursor (`activity.reads`); `set` stages one. */
  readonly activityReads: FakeActivityReads;
  installations: import("@ace/protocol").RegistryInstallation[] = [];
  /**
   * The provider CLIs discovery found on this machine. Like the daemon, only these have an
   * adapter, so `permissions.capabilities` for any other answers `provider_unavailable`.
   */
  installed = new Set<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi", "acp"]);
  localCommands = new Set(["fake-acp"]);
  private host: ServiceHost;
  private refreshingModels = new Set<string>();
  private refreshedModels = new Map<string, number>();
  constructor(host: ServiceHost) {
    this.host = host;
    const now = host.clock();
    // Quota resets are wall-clock facts the client compares with its own clock, as a real
    // daemon's are; the injected clock may be a counter.
    this.accounts = accountSummaries(Date.now());
    this.models = modelCatalog();
    // A realistic machine: most CLIs signed in, OpenCode signed out, Pi not reporting its
    // sign-in but working, and Cursor's sign-in expired (its catalog says so below).
    const loggedIn = new Set<ProviderKind>(["claude", "codex"]);
    this.providerStatuses = (
      ["claude", "codex", "opencode", "cursor", "pi", "antigravity"] as const
    ).map((provider): import("@ace/protocol").ProviderStatus => ({
      provider,
      runtime: "cli",
      installed: this.installed.has(provider),
      auth: loggedIn.has(provider)
        ? "logged_in"
        : provider === "opencode"
          ? "logged_out"
          : "unknown",
      accountLabel: loggedIn.has(provider) ? "ada@example.com" : undefined,
      loginHint: "Use the CLI login command",
      checkedAt: now,
      stale: false,
      refreshing: false,
    }));
    this.providerLogin = new FakeProviderLogin(
      host.clock,
      () => this.providerRows(),
      (provider, signedIn) => {
        this.providerStatuses = fakeReadiness(
          this.providerStatuses.map((row) =>
            row.provider === provider
              ? { ...row, auth: signedIn ? "logged_in" : "logged_out" }
              : row,
          ),
        );
        host.broadcast?.({
          type: "providers.changed",
          providers: onboardingChecklist(this.providerRows()).providers,
        });
        host.broadcast?.({ type: "models.changed", filter: { provider } });
      },
      (progress, push) => {
        const instanceId =
          progress.instance ??
          this.accounts.find(
            (account) => account.provider === progress.provider && account.implicit,
          )?.id;
        if (!instanceId) throw new Error("Instance unavailable");
        const terminalId = `provider-auth-${++this.accountCounter}`;
        this.authTerminals.set(terminalId, {
          instanceId,
          action: progress.action,
          owner: push,
          scope: "operate",
        });
        return terminalId;
      },
    );
    this.commands = commandCatalog();
    this.usage = new FakeUsage(now);
    this.activityReads = new FakeActivityReads(
      () => host.clock(),
      (message) => host.broadcast?.(message),
    );
    this.settings = new FakeSettings(
      settingsValues(),
      (threadId) => host.thread(threadId)?.workspaceId,
    );
  }
  /** Answers one service message. False when it isn't a service this fake serves. */
  handle(message: ClientMessage, push: Push, device = "fake-device"): boolean {
    if (this.providerLogin.handle(message, device, push)) return true;
    if (message.type === "models.refresh") {
      const instances = this.modelResult({
        ...message.filter,
        offset: 0,
        limit: 100,
      }).instances.filter((row) => row.enabled !== false);
      for (const row of instances) this.refreshingModels.add(row.instance);
      void Promise.resolve().then(() => {
        for (const row of instances) {
          this.refreshingModels.delete(row.instance);
          this.refreshedModels.set(row.instance, this.host.clock());
        }
        this.host.broadcast?.({ type: "models.changed", filter: message.filter });
        push({
          type: "models.result",
          requestId: message.requestId,
          result: this.modelResult({ ...message.filter, offset: 0, limit: 100 }),
        });
      });
      return true;
    }
    const reply = this.reply(message, push);
    if (reply) push(reply);
    return reply !== undefined;
  }
  completeAuthTerminal(id: string): void {
    const flow = this.authTerminals.get(id);
    const account = this.accounts.find((entry) => entry.id === flow?.instanceId);
    if (!flow || !account) return;
    account.quota.auth = flow.action === "login" ? "logged_in" : "logged_out";
    account.availability = flow.action === "login" ? "available" : "logged_out";
    this.models = this.models.filter((entry) => entry.instance !== account.id);
    if (flow.action === "login") {
      const templates = modelCatalog().filter((entry) => entry.provider === account.provider);
      this.models.push(
        ...templates.map((entry) => Object.assign({}, entry, { instance: account.id })),
      );
    }
    this.authTerminals.delete(id);
    this.providerStatuses = fakeReadiness(
      this.providerStatuses.map((row) =>
        row.provider === account.provider
          ? { ...row, auth: flow.action === "login" ? "logged_in" : "logged_out" }
          : row,
      ),
    );
    this.host.broadcast?.({
      type: "providers.changed",
      providers: onboardingChecklist(this.providerRows()).providers,
    });
    this.host.broadcast?.({ type: "models.changed", filter: { provider: account.provider } });
  }
  release(push: Push): void {
    this.providerLogin.release(push);
    for (const [id, flow] of this.authTerminals)
      if (flow.owner === push) this.authTerminals.delete(id);
    this.settings.release(push);
  }
  private providerRows(): import("@ace/protocol").ProviderStatus[] {
    const configurations = ProviderConfigurations.parse(
      this.settings.get("providers.configuration"),
    );
    return fakeReadiness(
      this.providerStatuses.map((row) => ({
        ...row,
        enabled: providerConfiguration(configurations, row.provider).enabled !== false,
      })),
    );
  }
  private modelResult(
    options: import("@ace/protocol").ModelListOptions,
  ): import("@ace/protocol").ModelListResult {
    const models = this.configuredModels();
    const instances = new Map<string, import("@ace/protocol").ModelInstanceStatus>();
    for (const model of models) {
      if (
        (options.provider && options.provider !== model.provider) ||
        (options.instance && options.instance !== model.instance)
      )
        continue;
      const cursorNeedsLogin =
        model.provider === "cursor" &&
        this.providerStatuses.find((row) => row.provider === "cursor")?.auth !== "logged_in";
      const refreshedAt =
        this.refreshedModels.get(model.instance) ?? Math.max(0, this.host.clock() - 60_000);
      instances.set(model.instance, {
        provider: model.provider,
        instance: model.instance,
        enabled: model.providerEnabled !== false,
        status: this.refreshingModels.has(model.instance)
          ? "refreshing"
          : cursorNeedsLogin || model.provider === "opencode"
            ? "stale"
            : "fresh",
        stale: cursorNeedsLogin || model.provider === "opencode",
        ...(cursorNeedsLogin
          ? {
              error: "discovery_failed",
              errorDetail: {
                code: "auth_expired",
                message: "Cursor sign-in has expired.",
                hint: "Sign in using Cursor, then refresh models.",
              },
            }
          : {}),
        sources: [
          ...new Map(
            models
              .filter((row) => row.instance === model.instance && row.source)
              .map((row) => [row.source?.id, row.source]),
          ).values(),
        ].flatMap((source) =>
          source
            ? [
                {
                  source,
                  status: this.refreshingModels.has(model.instance)
                    ? "refreshing"
                    : cursorNeedsLogin || source.id === "openrouter"
                      ? "stale"
                      : "fresh",
                  lastRefreshedAt: refreshedAt ?? Math.max(0, this.host.clock() - 60_000),
                  ...(source.id === "openrouter"
                    ? {
                        error: {
                          code: "unreachable",
                          message: "OpenRouter could not be reached.",
                          hint: "Check your network and refresh models.",
                        },
                      }
                    : cursorNeedsLogin
                      ? {
                          error: {
                            code: "auth_expired",
                            message: "Cursor sign-in has expired.",
                            hint: "Sign in using Cursor, then refresh models.",
                          },
                        }
                      : {}),
                },
              ]
            : [],
        ),
        refreshing: this.refreshingModels.has(model.instance),
        ...(refreshedAt === undefined ? {} : { refreshedAt, lastRefreshedAt: refreshedAt }),
      });
    }
    return {
      ...listModels(models, {
        ...options,
        offset: options.offset ?? 0,
        limit: options.limit ?? 100,
      }),
      instances: [...instances.values()],
    };
  }
  private configuredModels(): CatalogModel[] {
    const configurations = ProviderConfigurations.parse(
      this.settings.get("providers.configuration"),
    );
    const groups = new Map<string, CatalogModel[]>();
    for (const model of this.models) {
      const key = JSON.stringify([model.provider, model.instance]);
      const rows = groups.get(key) ?? [];
      rows.push(model);
      groups.set(key, rows);
    }
    for (const config of configurations) {
      if (config.instance) {
        const key = JSON.stringify([config.provider, config.instance]);
        if (!groups.has(key)) groups.set(key, []);
      }
    }
    return [...groups].flatMap(([key, models]) => {
      const [provider, instance] = zGroup.parse(JSON.parse(key));
      return configuredModels(
        models,
        provider,
        instance,
        providerConfiguration(configurations, provider, instance),
      );
    });
  }
  private reply(message: ClientMessage, push: Push): ServerMessage | undefined {
    const mutation = AccountManagementRequest.safeParse(message);
    if (mutation.success) {
      const request = mutation.data;
      const fail = (): ServerMessage => ({
        type: "error",
        requestId: request.requestId,
        code: "accounts_failed",
        message: "Account unavailable or immutable",
      });
      let account =
        "instanceId" in request
          ? this.accounts.find((entry) => entry.id === request.instanceId)
          : undefined;
      if (request.type === "accounts.add") {
        account = {
          id: `account-fake-${++this.accountCounter}`,
          provider: request.provider,
          label: request.label,
          implicit: false,
          isDefault: false,
          availability: "unknown",
          quota: {
            auth: "unknown",
            observedAt: this.host.clock(),
            windows: {},
            blockers: {},
            usage: {},
          },
        };
        this.accounts.push(account);
      } else {
        if (!account || (account.implicit && request.type !== "accounts.setDefault")) return fail();
        if (request.type === "accounts.rename") account.label = request.label;
        if (request.type === "accounts.setDefault") {
          if (account.provider !== request.provider) return fail();
          for (const entry of this.accounts)
            if (entry.provider === request.provider) entry.isDefault = entry.id === account.id;
        }
        if (request.type === "accounts.remove") {
          this.accounts = this.accounts.filter((entry) => entry !== account);
          if (account.isDefault) {
            const provider = account.provider;
            const fallback = this.accounts.find(
              (entry) => entry.provider === provider && entry.implicit,
            );
            if (fallback) fallback.isDefault = true;
          }
          const removedId = account.id;
          this.models = this.models.filter((entry) => entry.instance !== removedId);
          return { type: "accounts.changed", requestId: request.requestId, account: null };
        }
        if (request.type === "accounts.login" || request.type === "accounts.logout") {
          const terminalId = `auth-fake-${++this.accountCounter}`;
          this.authTerminals.set(terminalId, {
            instanceId: account.id,
            action: request.type === "accounts.login" ? "login" : "logout",
            owner: push,
          });
          return {
            type: "accounts.auth",
            requestId: request.requestId,
            instanceId: account.id,
            terminalId,
            ...(account.provider === "pi"
              ? { instruction: request.type === "accounts.login" ? "/login" : "/logout" }
              : {}),
          };
        }
      }
      return { type: "accounts.changed", requestId: request.requestId, account: account ?? null };
    }
    switch (message.type) {
      case "registry.list":
        return {
          type: "registry.result",
          requestId: message.requestId,
          result: {
            ok: true,
            agents: [],
            installations: this.installations,
            stale: false,
            refreshing: false,
            source: "fixture",
          },
        };
      case "registry.bind": {
        if (
          !message.acpAgentId.startsWith("local:") ||
          !this.localCommands.has(message.command) ||
          this.installations.some((entry) => entry.installationId === message.installationId)
        )
          return {
            type: "registry.result",
            requestId: message.requestId,
            result: { ok: false, reason: "Registry operation unavailable or invalid" },
          };
        const installation = {
          acpAgentId: message.acpAgentId,
          installationId: message.installationId,
          instanceId: message.instanceId,
          version: message.version,
          source: "user-local",
          profileRevision: "generic-v1",
          evidence: "user_local_binding" as const,
        };
        this.installations.push(installation);
        return {
          type: "registry.result",
          requestId: message.requestId,
          result: { ok: true, installation },
        };
      }
      case "accounts.list":
        return { type: "accounts.list", requestId: message.requestId, accounts: this.accounts };
      case "accounts.status":
        return {
          type: "accounts.status",
          requestId: message.requestId,
          account: this.accounts.find((account) => account.id === message.instanceId) ?? null,
        };
      case "usage.summary":
      case "usage.series":
        return {
          type: "usage.result",
          requestId: message.requestId,
          kind: message.type === "usage.summary" ? "summary" : "series",
          result: this.usage.report(
            message.query,
            message.type === "usage.summary" ? "summary" : "series",
          ),
        };
      case "accounts.migrate":
        return {
          type: "accounts.migrate",
          requestId: message.requestId,
          result: { status: "unsupported", reason: "No native sessions in the fake daemon" },
        };
      case "usage.session_totals":
        return {
          type: "usage.session_totals.result",
          requestId: message.requestId,
          totals: this.usage.sessionTotals(message.query),
        };
      case "providers.request":
        return {
          type: "providers.result",
          requestId: message.requestId,
          result: {
            ok: true,
            providers:
              message.operation === "readiness"
                ? onboardingChecklist(this.providerRows()).providers
                : this.providerRows(),
          },
        };
      case "models.list":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: this.modelResult(message.options),
        };
      case "models.refresh":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: this.modelResult({ ...message.filter, offset: 0, limit: 100 }),
        };
      case "models.resolve":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: resolveModel(this.configuredModels(), message.roleSpec),
        };
      case "activity.reads":
      case "activity.markRead":
        return this.activityReads.handle(message);
      case "settings.get":
      case "settings.set":
      case "settings.subscribe":
      case "settings.unsubscribe":
        return this.settings.handle(message, push);
      case "permissions.capabilities":
        return this.installed.has(message.provider)
          ? {
              type: "permissions.capabilities.result",
              requestId: message.requestId,
              ok: true,
              permissions: fakeProviderPermissions(message.provider),
            }
          : {
              type: "permissions.capabilities.result",
              requestId: message.requestId,
              ok: false,
              error: "provider_unavailable",
            };
      case "search.query":
        return {
          type: "search.results",
          requestId: message.requestId,
          ...search(message, this.host.clock()),
        };
      case "search.status":
        return {
          type: "search.progress",
          requestId: message.requestId,
          indexedSeq: 0,
          headSeq: 0,
          pending: 0,
          indexWrites: 0,
          generation: 1,
          ready: true,
        };
      case "commands.list":
        if (message.draft) return undefined;
        return {
          type: "commands.list.result",
          requestId: message.requestId,
          commands: listCommands(
            this.commands,
            message.threadId ? this.host.thread(message.threadId)?.provider : undefined,
            message.query,
            message.limit,
          ),
          diagnostics: [],
        };
      case "commands.resolve":
        return {
          type: "commands.resolve.result",
          requestId: message.requestId,
          result: { ok: false, error: "not_found" },
        };
      default:
        return undefined;
    }
  }
}
export { FakeSettings } from "./settings.ts";
export type { Push } from "./settings.ts";
