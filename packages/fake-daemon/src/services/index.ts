import type { FakeAuthTerminal } from "../auth-terminal-output.ts";
import { fakeProviderAccounts } from "./provider-accounts.ts";
import { fakeApiKeySupport } from "../provider-auth-support.ts";
import { FakeProviderInstalls, fakeLatestVersions } from "../provider-install.ts";
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
import { availability, blockedUntil } from "@ace/accounts/availability";
import { commandCatalog, listCommands } from "./commands.ts";
import { search } from "./search.ts";
import { listModels, resolveModel } from "./models.ts";
import { FakeSettings, type Push } from "./settings.ts";
import { FakeActivityReads } from "./activity-reads.ts";
import { FakeRegistry } from "./registry.ts";
import { fakeProviderPermissions } from "../permissions.ts";

type AccountSummary = z.infer<typeof Summary>;

export interface ServiceHost {
  clock(): number;
  /** Sends to every authenticated connection, as the daemon's pushes do (none when absent). */
  broadcast?(message: ServerMessage): void;
  /** The thread's project and provider, or undefined when the thread doesn't exist. */
  thread(threadId: string): { workspaceId: string; provider: ProviderKind } | undefined;
}

/** Where discovery found each CLI on the fake machine, and its version. */
const fakeInstall: Partial<Record<ProviderKind, { version: string; path?: string }>> = {
  claude: { version: "2.1.4", path: "/opt/homebrew/bin/claude" },
  codex: { version: "0.159.2", path: "/opt/homebrew/bin/codex" },
  opencode: { version: "1.4.2", path: "/Users/ada/.opencode/bin/opencode" },
  cursor: { version: "1.0.35" },
  pi: { version: "0.31.0", path: "/Users/ada/.local/bin/pi" },
};

/**
 * The daemon's catalog services (accounts, usage, models, settings, search, slash commands) over
 * the fake daemon's catalogs. Context, workspace, terminal, plugin, planning and browser services
 * are per-connection sessions in `services-wire.ts`. Replies use the wire shapes, so the app
 * reads them through `Client.request` exactly as it does from a real daemon. Tests change the
 * public fields to stage what the daemon reports next.
 */
export class FakeServices {
  readonly providerInstalls: FakeProviderInstalls;
  updateQuota(id: string, quota: AccountSummary["quota"]): void {
    const account = this.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new Error("Unknown fake account");
    Object.assign(account, {
      quota,
      availability: availability(quota, this.host.clock()),
      blockedUntil: blockedUntil(quota, this.host.clock()),
    });
    this.host.broadcast?.({ type: "usage.limits_changed", account });
  }
  readonly providerLogin: FakeProviderLogin;
  accounts: AccountSummary[];
  readonly authTerminals = new Map<string, FakeAuthTerminal>();
  private accountCounter = 0;
  models: CatalogModel[];
  /** Source metadata can exist even when no chat models are enabled. */
  modelSources = new Map<string, import("@ace/protocol").ModelSourceStatus[]>();
  providerStatuses: import("@ace/protocol").ProviderStatus[];
  commands: PaletteCommand[];
  /** Usage over time and Claude's per-session totals; replace its fields to stage a report. */
  readonly usage: FakeUsage;
  readonly settings: FakeSettings;
  /** Activity's read cursor (`activity.reads`); `set` stages one. */
  readonly activityReads: FakeActivityReads;
  /** The ACP registry: its cached index, installations and installs in progress. */
  readonly registry: FakeRegistry;
  /**
   * The provider CLIs discovery found on this machine. Like the daemon, only these have an
   * adapter, so `permissions.capabilities` for any other answers `provider_unavailable`.
   */
  installed = new Set<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi", "acp"]);
  /** Upstream sources (OpenCode's, Pi's) whose models can't be read: OpenRouter by default. */
  failingSources = new Set(["openrouter"]);
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
    // A realistic machine: Claude Code signed in, Codex's own CLI login signed out, OpenCode
    // and Pi not reporting a sign-in but connected through their upstreams (the catalog lists
    // their models), and Cursor's sign-in expired (its catalog says so below).
    const loggedIn = new Set<ProviderKind>(["claude"]);
    this.providerStatuses = (
      ["claude", "codex", "opencode", "cursor", "pi", "antigravity"] as const
    ).map((provider): import("@ace/protocol").ProviderStatus => ({
      provider,
      runtime: provider === "cursor" ? "cursor-sdk" : "cli",
      installed: this.installed.has(provider),
      auth: loggedIn.has(provider) ? "logged_in" : provider === "codex" ? "logged_out" : "unknown",
      apiKey: fakeApiKeySupport(provider),
      authMethod: loggedIn.has(provider) ? "browser" : "unknown",
      accountLabel: loggedIn.has(provider) ? "ada@example.com" : undefined,
      loginHint: provider === "cursor" ? "Sign in to Cursor" : "Use the CLI login command",
      updateAvailable: provider === "codex",
      latestVersion: provider === "codex" ? fakeLatestVersions.codex : undefined,
      checkedAt: now,
      stale: false,
      refreshing: false,
    }));
    for (const row of this.providerStatuses)
      if (this.installed.has(row.provider)) Object.assign(row, fakeInstall[row.provider]);
    this.providerInstalls = new FakeProviderInstalls(
      () => this.providerRows(),
      (progress) => {
        const installed = progress.action !== "uninstall";
        if (progress.acpAgentId && installed) {
          const agent = this.registry.entries.find(
            (entry) => entry.agent.acpAgentId === progress.acpAgentId,
          )?.agent;
          const metadata = {
            acpAgentId: progress.acpAgentId,
            installationId: progress.session,
            instanceId: `${progress.session}:default`,
            version: progress.plan?.latestVersion ?? "1.0.0",
            profileRevision: "generic-v1",
            source: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
            evidence: "unsigned_https" as const,
          };
          this.registry.installations.push(metadata);
          const example = this.accounts.find((account) => account.provider === "acp");
          if (example)
            this.accounts.push({
              ...example,
              id: metadata.instanceId,
              acpAgentId: metadata.acpAgentId,
              installationId: metadata.installationId,
              label: agent?.name ?? "Agent",
              availability: "logged_out",
              quota: {
                auth: "logged_out",
                observedAt: this.host.clock(),
                windows: {},
                blockers: {},
                usage: {},
              },
            });
        }
        if (installed) this.installed.add(progress.provider);
        else this.installed.delete(progress.provider);
        this.providerStatuses = fakeReadiness(
          this.providerStatuses.map((row) => {
            if (row.provider !== progress.provider) return row;
            const {
              version: _version,
              path: _path,
              readiness: _readiness,
              state: _state,
              actionId: _actionId,
              ...rest
            } = row;
            return {
              ...rest,
              installed,
              auth: installed ? (row.installed ? row.auth : "logged_out") : "unknown",
              updateAvailable: false,
              ...(installed
                ? {
                    version: progress.plan?.latestVersion ?? row.version,
                    path: `/fake/bin/${progress.provider}`,
                    latestVersion: progress.plan?.latestVersion ?? row.latestVersion,
                  }
                : {}),
            };
          }),
        );
        this.host.broadcast?.({ type: "providers.changed", providers: this.providerRows() });
        this.host.broadcast?.({ type: "models.changed", filter: { provider: progress.provider } });
      },
      (id) => this.registry.entries.find((entry) => entry.agent.acpAgentId === id)?.agent,
    );
    this.providerLogin = new FakeProviderLogin(
      host.clock,
      () => this.providerRows(),
      (provider, signedIn, instance, method) => {
        const selected = this.accounts.find(
          (row) => row.provider === provider && (instance ? row.id === instance : row.implicit),
        );
        if (selected) {
          selected.quota.auth = signedIn ? "logged_in" : "logged_out";
          selected.availability = signedIn ? "available" : "logged_out";
          selected.authMethod = signedIn
            ? method === "api_key"
              ? "api_key"
              : "browser"
            : "unknown";
          selected.loginRevision = String(Number(selected.loginRevision ?? "0") + 1);
          this.models = this.models.filter((entry) => entry.instance !== selected.id);
          if (signedIn) {
            const templates = modelCatalog().filter((entry) => entry.provider === provider);
            const first = templates[0]?.instance;
            this.models.push(
              ...templates
                .filter((entry) => entry.instance === first)
                .map((entry) =>
                  Object.assign({}, entry, {
                    instance: selected.id,
                    ...(!entry.source || entry.source.kind === "account"
                      ? {
                          source: {
                            kind: "account" as const,
                            id: selected.id,
                            label: selected.label,
                          },
                        }
                      : {}),
                  }),
                ),
            );
          }
        }
        if (!instance || selected?.implicit)
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
          session: progress.session,
          provider: progress.provider,
          action: progress.action,
          owner: push,
          scope: "operate",
        });
        return terminalId;
      },
    );
    this.registry = new FakeRegistry({
      // Wall-clock facts, like quota resets above; steps on real timers so dev:fake animates.
      now: () => Date.now(),
      schedule: (callback, delayMs) => void setTimeout(callback, delayMs),
    });
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
    if (
      fakeProviderAccounts(message, {
        accounts: () => this.accounts,
        replace: (accounts) => {
          this.accounts = accounts;
        },
        id: () => `account-fake-${++this.accountCounter}`,
        now: this.host.clock,
        login: this.providerLogin,
        owner: device,
        push,
      })
    )
      return true;
    if (this.providerInstalls.handle(message, device, push)) return true;
    if (this.providerLogin.handle(message, device, push)) return true;
    if (this.registry.handle(message, push)) return true;
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
    if (flow?.session) {
      this.providerLogin.finishTerminal(flow.session);
      this.authTerminals.delete(id);
      return;
    }
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
    this.providerInstalls.release(push);
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
          ...(this.modelSources.get(model.instance) ?? []),
          ...[
            ...new Map(
              models
                .filter((row) => row.instance === model.instance && row.source)
                .map((row) => [row.source?.id, row.source]),
            ).values(),
          ].flatMap<import("@ace/protocol").ModelSourceStatus>((source) =>
            source
              ? [
                  {
                    source,
                    status: this.refreshingModels.has(model.instance)
                      ? "refreshing"
                      : cursorNeedsLogin || this.failingSources.has(source.id)
                        ? "stale"
                        : "fresh",
                    lastRefreshedAt: refreshedAt ?? Math.max(0, this.host.clock() - 60_000),
                    ...(this.failingSources.has(source.id)
                      ? {
                          error: {
                            code: "unreachable",
                            message: `${source.label} could not be reached.`,
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
        ],
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
          shortLabel: request.shortLabel,
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
        if (request.type === "accounts.rename") {
          account.label = request.label;
          account.shortLabel = request.shortLabel ?? account.shortLabel;
          account.badgeColor =
            request.badgeColor === null ? undefined : (request.badgeColor ?? account.badgeColor);
          this.host.broadcast?.({ type: "usage.limits_changed", account });
        }
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
          result: {
            ...this.usage.report(
              message.query,
              message.type === "usage.summary" ? "summary" : "series",
            ),
            ...(message.query.filters.provider || message.query.filters.account
              ? {
                  accounts: this.accounts.filter(
                    (account) =>
                      (!message.query.filters.provider ||
                        message.query.filters.provider.includes(account.provider)) &&
                      (!message.query.filters.account ||
                        message.query.filters.account.includes(account.id)),
                  ),
                }
              : {}),
          },
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
      case "settings.reset":
      case "settings.set":
      case "settings.subscribe":
      case "settings.unsubscribe":
        return this.settings.handle(message, push);
      case "permissions.capabilities":
        return message.provider === "pi" || this.installed.has(message.provider)
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
