import { defaults } from "@ace/settings/defaults";
import {
  SettingsEntry,
  type SettingsScope,
  SettingsKey,
  SettingsValues,
  ServerMessage,
  type ClientMessage,
  type ServerMessage as Message,
} from "@ace/protocol";
import { settingsFixture } from "./scenarios/settings.ts";
import { accountList } from "./catalog/accounts.ts";
import { usageReport } from "./catalog/usage.ts";
import type { FakeServiceContext } from "./service-context.ts";
export class FakeCatalogWire {
  private context: FakeServiceContext;
  private values = new Map<string, unknown>();
  private layers = new Map<string, Map<string, unknown>>();
  private subscriptions = new Map<
    string,
    { keys: string[]; scope: SettingsScope; send(message: Message): void }
  >();
  constructor(context: FakeServiceContext) {
    this.context = context;
    for (const [key, value] of Object.entries({
      ...defaults,
      ...settingsFixture(context.now()).values,
    }))
      this.values.set(key, value);
  }
  private entry(key: string, scope: SettingsScope = {}) {
    const thread = scope.threadId ? this.context.thread(scope.threadId)?.thread : undefined;
    const workspace = scope.workspaceId ?? thread?.workspaceId;
    const threadValues = scope.threadId ? this.layers.get(`thread:${scope.threadId}`) : undefined;
    const workspaceValues = workspace ? this.layers.get(`workspace:${workspace}`) : undefined;
    return SettingsEntry.parse({
      key,
      value: threadValues?.get(key) ?? workspaceValues?.get(key) ?? this.values.get(key) ?? null,
      provenance: threadValues?.has(key)
        ? "thread"
        : workspaceValues?.has(key)
          ? "workspace"
          : "global",
    });
  }
  organizationEntries(scope: SettingsScope) {
    return ["threads.autoSettleAfter", "threads.settleOnMerge", "threads.settleOnClose"].map(
      (key) => this.entry(key, scope),
    );
  }
  release(owner: string): void {
    for (const key of this.subscriptions.keys())
      if (key.startsWith(`${owner}/`)) this.subscriptions.delete(key);
  }
  automationsEnabled(): boolean {
    return this.values.get("automations.enabled") === true;
  }
  handle(
    message: ClientMessage,
    send: (message: Message) => void,
    owner: string,
  ): Message | undefined {
    if (!("requestId" in message)) return undefined;
    const requestId = message.requestId;
    const reply = (input: unknown) => ServerMessage.parse({ requestId, ...Object(input) });
    switch (message.type) {
      case "settings.unsubscribe":
        this.subscriptions.delete(`${owner}/${message.subscriptionId}`);
        return reply({ type: "settings.result", ok: true, entries: [], diagnostics: [] });
      case "settings.get":
        return reply({
          type: "settings.result",
          ok: true,
          entries: [this.entry(message.key, message.scope)],
          diagnostics: [],
        });
      case "settings.set": {
        const key = SettingsKey.safeParse(message.key);
        if (!key.success)
          return reply({
            type: "settings.result",
            ok: false,
            entries: [],
            diagnostics: [{ layer: "global", code: "validation", message: "Unknown setting" }],
          });
        const value = SettingsValues.shape[key.data].safeParse(message.value);
        if (!value.success)
          return reply({
            type: "settings.result",
            ok: false,
            entries: [],
            diagnostics: [
              { layer: "global", code: "validation", message: "Invalid setting value" },
            ],
          });
        const layer = message.layer;
        const id =
          layer.kind === "global"
            ? undefined
            : layer.kind === "thread"
              ? `thread:${layer.threadId}`
              : `workspace:${layer.workspaceId}`;
        let values = id ? this.layers.get(id) : this.values;
        if (!values) {
          if (this.layers.size >= 256) throw new Error("settings_layer_limit");
          values = new Map();
          this.layers.set(id ?? "", values);
        }
        values.set(key.data, value.data);
        for (const [subscriptionKey, subscription] of this.subscriptions)
          if (subscription.keys.includes(key.data))
            subscription.send(
              ServerMessage.parse({
                type: "settings.changed",
                subscriptionId: subscriptionKey.slice(subscriptionKey.indexOf("/") + 1),
                entries: [this.entry(key.data, subscription.scope)],
              }),
            );
        return reply({
          type: "settings.result",
          ok: true,
          entries: [
            this.entry(
              key.data,
              message.layer.kind === "thread"
                ? { threadId: message.layer.threadId }
                : message.layer.kind === "workspace"
                  ? { workspaceId: message.layer.workspaceId }
                  : {},
            ),
          ],
          diagnostics: [],
        });
      }
      case "settings.subscribe": {
        if (this.subscriptions.size >= 64)
          return reply({
            type: "settings.result",
            ok: false,
            entries: [],
            diagnostics: [{ layer: "global", code: "limit", message: "Subscription limit" }],
          });
        this.subscriptions.set(`${owner}/${message.subscriptionId}`, {
          keys: message.keys,
          scope: message.scope,
          send,
        });
        return reply({
          type: "settings.result",
          ok: true,
          entries: message.keys.map((key) => this.entry(key, message.scope)),
          diagnostics: [],
        });
      }
      case "models.list":
      case "models.refresh":
      case "models.resolve": {
        const options =
          message.type === "models.list"
            ? message.options
            : message.type === "models.refresh"
              ? message.filter
              : message.roleSpec;
        const models = settingsFixture(this.context.now()).models.filter(
          (model) =>
            (!options.provider || options.provider === model.provider) &&
            (!options.instance || options.instance === model.instance),
        );
        if (message.type === "models.resolve") {
          const model = models.find(
            (entry) =>
              !message.roleSpec.model ||
              entry.nativeModelId === message.roleSpec.model ||
              entry.id === message.roleSpec.model,
          );
          return reply({
            type: "models.result",
            result: model
              ? { ok: true, model, stale: false, reason: "Fake catalog" }
              : { ok: false, reason: "Model unavailable" },
          });
        }
        const offset = message.type === "models.list" ? message.options.offset : 0,
          limit = message.type === "models.list" ? message.options.limit : 100;
        return reply({
          type: "models.result",
          result: {
            models: models.slice(offset, offset + limit),
            instances: [],
            ...(models.length > offset + limit ? { nextOffset: offset + limit } : {}),
          },
        });
      }
      case "accounts.list":
      case "accounts.status": {
        const accounts = accountList(this.context.now())
          .filter((account) => account.provider !== "acp")
          .map((account) => ({
            id: account.id,
            provider: account.provider,
            label: account.label,
            availability: account.availability,
            quota: {
              auth: account.availability === "logged_out" ? "logged_out" : "logged_in",
              observedAt: this.context.now(),
              windows: Object.fromEntries(
                account.windows.map((window) => [
                  window.id,
                  { usedPercent: window.usedPercent, resetsAt: window.resetsAt },
                ]),
              ),
              usage: {},
            },
          }));
        return reply(
          message.type === "accounts.list"
            ? { type: message.type, accounts }
            : {
                type: message.type,
                account: accounts.find((account) => account.id === message.instanceId) ?? null,
              },
        );
      }
      case "accounts.migrate":
        return reply({
          type: message.type,
          result: { status: "unsupported", reason: "No native sessions in fake daemon" },
        });
      case "usage.summary":
      case "usage.series":
        return reply({
          type: "usage.result",
          kind: message.type === "usage.summary" ? "summary" : "series",
          result: usageReport(message.query),
        });
      case "usage.session_totals":
        return reply({ type: "usage.session_totals.result", totals: [] });
      case "commands.list":
        return reply({ type: "commands.list.result", commands: [], diagnostics: [] });
      case "commands.resolve":
        return reply({
          type: "commands.resolve.result",
          result: { ok: false, error: "not_found" },
        });
      case "files.request":
        return reply({ type: "files.error", code: "not_found", message: "No file fixture" });
      case "search.status":
        return reply({
          type: "search.progress",
          indexedSeq: 0,
          headSeq: 0,
          pending: 0,
          indexWrites: 0,
          generation: 1,
          ready: true,
        });
      case "search.query": {
        const matches = this.context
          .threads()
          .filter(
            (thread) =>
              thread.deletedAt === undefined &&
              thread.title.toLowerCase().includes(message.text.toLowerCase()) &&
              (!message.filters.workspaceId ||
                message.filters.workspaceId === thread.workspaceId) &&
              (!message.filters.provider || message.filters.provider === thread.provider),
          );
        return reply({
          type: "search.results",
          generation: 1,
          cursor: null,
          hits: matches.slice(0, message.limit).map((thread) => ({
            threadId: thread.id,
            threadTitle: thread.title,
            workspaceId: thread.workspaceId,
            provider: thread.provider,
            status: thread.status.state,
            statusSeq: 0,
            kind: "thread",
            createdAt: thread.createdAt,
            title: { text: thread.title, highlights: [] },
            snippet: { text: "", highlights: [] },
            score: 1,
          })),
        });
      }
    }
    return undefined;
  }
}
