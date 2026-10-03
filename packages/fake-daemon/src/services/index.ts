import type { z } from "zod";
import type { AccountSummary as Summary } from "@ace/protocol/accounts";
import type {
  CatalogModel,
  ClientMessage,
  PaletteCommand,
  ProviderKind,
  ServerMessage,
} from "@ace/protocol";
import { usageReport } from "../catalog/usage.ts";
import { settingsFixture } from "../scenarios/settings.ts";
import { accountSummaries } from "./accounts.ts";
import { commandCatalog, listCommands } from "./commands.ts";
import { FakeContext } from "./context.ts";
import { search } from "./search.ts";
import { FakeSettings, type Push } from "./settings.ts";

type AccountSummary = z.infer<typeof Summary>;

export interface ServiceHost {
  clock(): number;
  /** The thread's project and provider, or undefined when the thread doesn't exist. */
  thread(threadId: string): { workspaceId: string; provider: ProviderKind } | undefined;
}

/**
 * The daemon's request/response services (accounts, usage, models, settings, search, slash
 * commands, context) over the fake daemon's catalogs. Replies use the wire shapes, so the app
 * reads them through `Client.request` exactly as it does from a real daemon. Tests change the
 * public fields to stage what the daemon reports next.
 */
export class FakeServices {
  accounts: AccountSummary[];
  models: CatalogModel[];
  commands: PaletteCommand[];
  readonly settings: FakeSettings;
  readonly context: FakeContext;
  private host: ServiceHost;
  constructor(host: ServiceHost) {
    this.host = host;
    const now = host.clock();
    const fixture = settingsFixture(now);
    this.accounts = accountSummaries(now);
    this.models = fixture.models;
    this.commands = commandCatalog();
    this.settings = new FakeSettings(fixture.values);
    this.context = new FakeContext((threadId) => host.thread(threadId)?.workspaceId);
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
          result: usageReport(message.query),
        };
      case "models.list":
      case "models.refresh": {
        const filter = message.type === "models.list" ? message.options : message.filter;
        const models = this.models.filter(
          (model) =>
            (!filter.provider || model.provider === filter.provider) &&
            (!filter.instance || model.instance === filter.instance),
        );
        return {
          type: "models.result",
          requestId: message.requestId,
          result: { models: models.slice(0, 100), instances: [] },
        };
      }
      case "settings.get":
      case "settings.set":
      case "settings.subscribe":
        return this.settings.handle(message, push);
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
        return {
          type: "commands.list.result",
          requestId: message.requestId,
          commands: listCommands(
            this.commands,
            this.host.thread(message.threadId)?.provider,
            message.query,
            message.limit,
          ),
          diagnostics: [],
        };
      case "context.request":
        return {
          type: "context.result",
          requestId: message.requestId,
          result: this.context.handle(message.operation),
        };
      default:
        return undefined;
    }
  }
}
export { FakeSettings } from "./settings.ts";
export type { Push } from "./settings.ts";
