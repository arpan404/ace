import type { z } from "zod";
import type { AccountSummary as Summary } from "@ace/protocol/accounts";
import type {
  CatalogModel,
  ClientMessage,
  PaletteCommand,
  ProviderKind,
  ServerMessage,
} from "@ace/protocol";
import { FakeUsage } from "../catalog/usage.ts";
import { modelCatalog, settingsValues } from "../scenarios/settings.ts";
import { accountSummaries } from "./accounts.ts";
import { commandCatalog, listCommands } from "./commands.ts";
import { search } from "./search.ts";
import { listModels, resolveModel } from "./models.ts";
import { FakeSettings, type Push } from "./settings.ts";
import { fakePermissionCapabilities } from "../permissions.ts";

type AccountSummary = z.infer<typeof Summary>;

export interface ServiceHost {
  clock(): number;
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
  accounts: AccountSummary[];
  models: CatalogModel[];
  commands: PaletteCommand[];
  /** Usage over time and Claude's per-session totals; replace its fields to stage a report. */
  readonly usage: FakeUsage;
  readonly settings: FakeSettings;
  installations: import("@ace/protocol").RegistryInstallation[] = [];
  /**
   * The provider CLIs discovery found on this machine. Like the daemon, only these have an
   * adapter, so `permissions.capabilities` for any other answers `provider_unavailable`.
   */
  installed = new Set<ProviderKind>(["claude", "codex", "opencode", "cursor", "acp"]);
  localCommands = new Set(["fake-acp"]);
  private host: ServiceHost;
  constructor(host: ServiceHost) {
    this.host = host;
    const now = host.clock();
    this.accounts = accountSummaries(now);
    this.models = modelCatalog();
    this.commands = commandCatalog();
    this.usage = new FakeUsage(now);
    this.settings = new FakeSettings(
      settingsValues(),
      (threadId) => host.thread(threadId)?.workspaceId,
    );
  }
  /** Answers one service message. False when it isn't a service this fake serves. */
  handle(message: ClientMessage, push: Push): boolean {
    const reply = this.reply(message, push);
    if (reply) push(reply);
    return reply !== undefined;
  }
  release(push: Push): void {
    this.settings.release(push);
  }
  private reply(message: ClientMessage, push: Push): ServerMessage | undefined {
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
          result: this.usage.report(message.query),
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
      case "models.list":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: listModels(this.models, message.options),
        };
      case "models.refresh":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: listModels(this.models, { ...message.filter, offset: 0, limit: 100 }),
        };
      case "models.resolve":
        return {
          type: "models.result",
          requestId: message.requestId,
          result: resolveModel(this.models, message.roleSpec),
        };
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
              permissions: structuredClone(fakePermissionCapabilities.permissions),
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
