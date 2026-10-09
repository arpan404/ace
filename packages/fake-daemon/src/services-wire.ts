import { FakePromptFiles, type PromptSeed } from "./prompt-files.ts";
import { FakeCatalogWire } from "./catalog-wire.ts";
import { FakeHistory } from "./history-wire.ts";
import { FakeMcpWire } from "./mcp-wire.ts";
import {
  BrowserClientMessage,
  ServerMessage,
  type ClientMessage,
  type ServerMessage as Message,
  type CommandPayload,
  type CommandResult,
  type ForgePrStatus,
} from "@ace/protocol";
import { commandCatalog, listCommands } from "./services/commands.ts";
import { FakeFilesWire } from "./files-wire.ts";
import { bindFakeBrowserOrigins } from "./browser-origins.ts";
import { FakeBrowser } from "./browser.ts";
import { fakeBrowserSession } from "./browser-wire.ts";
import { FakeTerminalStream } from "./terminal-stream.ts";
import { fakeHealth } from "./health.ts";
import { FakeContextWire } from "./context-wire.ts";
import { FakeWorkspaceWire } from "./workspace-wire.ts";
import { FakeAutomationWire, type AutomationSeed } from "./automation-wire.ts";
import { FakePluginsWire, type PluginSeed } from "./plugins-wire.ts";
import type { FakeServiceContext, FakeWireSession } from "./service-context.ts";
export type { FakeWireSession } from "./service-context.ts";
import type { FakeSettings } from "./services/settings.ts";
/** Service state a daemon accumulates over time, which scenario facts can't reach. */
export interface ServicesSeed extends AutomationSeed {
  promptFiles?: readonly PromptSeed[];
  extensionCatalogs?: Partial<
    Record<import("@ace/protocol").ProviderKind, import("@ace/protocol").CatalogEntry[]>
  >;
  historyTranscripts?: Record<string, { role: "user" | "assistant"; text: string; at?: number }[]>;
  history?: import("@ace/protocol").HistorySession[];
  historyScan?: import("@ace/protocol").HistoryScanStatus;
  /** Seed the small PNG fixture for scoped client attachment reads. */
  notificationPublicKey?: string;
  attachmentImages?: { threadId: string; name?: string }[];
  plugins?: PluginSeed;
  /** Pull requests linked to existing threads, by thread id. */
  pullRequests?: Record<string, ForgePrStatus>;
  /** Global settings the person has changed from the shipped defaults. */
  settings?: Readonly<Record<string, unknown>>;
}
/** A correlated request no fixture service answers gets the daemon's `unsupported` error. */
export function replyUnsupported(message: ClientMessage, send: (message: Message) => void): void {
  if ("requestId" in message && message.requestId)
    send({
      type: "error",
      requestId: message.requestId,
      code: "unsupported",
      message: "Service unavailable in this fixture",
    });
}
/**
 * Per-connection services: context drafts and uploads, workspace reads, health, plugins,
 * and automations, previews, terminals and the browser. Catalog services and settings are
 * `FakeServices`; this reads settings through the same store.
 */
export class FakeServicesWire {
  readonly prompts = new FakePromptFiles();
  private readonly catalog = new FakeCatalogWire(this.prompts, (provider) =>
    this.plugins.extensions(provider),
  );
  readonly history: FakeHistory;
  private notificationPublicKey: string | null = null;
  readonly mcp = new FakeMcpWire();
  readonly browser = new FakeBrowser();
  readonly context: FakeContextWire;
  readonly workspace: FakeWorkspaceWire;
  readonly files: FakeFilesWire;
  private automations: FakeAutomationWire;
  private plugins = new FakePluginsWire();
  private connectionSequence = 0;
  private host: FakeServiceContext;
  private settings: FakeSettings;
  private providerStatuses: () => readonly import("@ace/protocol").ProviderStatus[];
  constructor(
    context: FakeServiceContext,
    settings: FakeSettings,
    providerStatuses: () => readonly import("@ace/protocol").ProviderStatus[],
  ) {
    this.host = context;
    this.providerStatuses = providerStatuses;
    this.history = new FakeHistory(context);
    bindFakeBrowserOrigins(this.browser, context, settings);
    this.files = new FakeFilesWire(context);
    this.settings = settings;
    this.context = new FakeContextWire(context, (threadId) => this.files.paths(threadId));
    this.workspace = new FakeWorkspaceWire(context);
    this.automations = new FakeAutomationWire(
      context.now,
      () => settings.get("automations.enabled") === true,
      context,
    );
  }
  seed(seed: ServicesSeed): void {
    if (seed.promptFiles) this.prompts.seed(seed.promptFiles);
    if (seed.extensionCatalogs) this.catalog.seed(seed.extensionCatalogs);
    if (seed.history) this.history.seed(seed.history, seed.historyTranscripts);
    if (seed.historyScan) this.history.seedScan(seed.historyScan);
    this.notificationPublicKey = seed.notificationPublicKey ?? null;
    for (const image of seed.attachmentImages ?? [])
      this.context.seedImage(image.threadId, image.name);
    if (seed.settings) this.settings.seed(seed.settings);
    this.automations.seed(seed);
    if (seed.plugins) this.plugins.seed(seed.plugins);
    // A seed describes the whole world; pull requests for threads this daemon lacks are skipped.
    for (const [threadId, status] of Object.entries(seed.pullRequests ?? {}))
      if (this.host.thread(threadId)) this.workspace.forge.seed(threadId, status);
  }
  command(
    payload: CommandPayload,
    commandId?: string,
  ): Omit<CommandResult, "commandId"> | undefined {
    return this.workspace.command(payload, commandId);
  }
  session(send: (message: Message) => void): FakeWireSession {
    const subscriptions = new Map<string, () => void>();
    const terminalStreams = new Map<string, FakeTerminalStream>();
    let closed = false;
    let owner = "";
    const emit = (message: Message) => {
      if (!closed) send(ServerMessage.parse(message));
    };
    const stopProjects = this.workspace.projects.subscribe((message) => {
      if (
        owner &&
        (this.host.canManageProjects?.(owner) ?? true) &&
        (message.type === "workspace.changed" ||
          this.workspace.projects.cloneOwner(message.commandId) === owner)
      )
        emit(message);
    });
    let picker: AbortController | undefined;
    const files = this.files.session(emit);
    const catalog = this.catalog.session(this.host, this.context, emit);
    const browser = fakeBrowserSession(
      this.browser,
      this.host,
      emit,
      `fake-browser-${++this.connectionSequence}`,
    );
    return {
      authenticated: (device) => {
        owner = device;
        catalog.authenticated?.(device);
      },
      close: () => {
        closed = true;
        catalog.close();
        picker?.abort();
        stopProjects();

        browser.close();
        files.close();
        for (const stop of subscriptions.values()) stop();
        subscriptions.clear();
        terminalStreams.clear();
      },
      handle: async (message, device) => {
        if (this.history.handle(message, emit)) return;
        try {
          if (message.type === "prompts.request") {
            emit({
              type: "prompts.result",
              requestId: message.requestId,
              result: this.prompts.request(message.operation),
            });
            return;
          }
          if (message.type === "catalog.list" || message.type === "catalog.unsubscribe") {
            await catalog.handle(message, device);
            return;
          }
          if (this.mcp.handle(message, emit)) return;
          if (message.type === "notification.config") {
            emit({
              type: "notification.config.result",
              requestId: message.requestId,
              publicKey: this.notificationPublicKey,
              preferences: { includePreview: false, quietHours: null },
            });
            return;
          }
          if (message.type === "notification.register") {
            if (message.requestId)
              emit({ type: "notification.register.result", requestId: message.requestId });
            return;
          }
          if (message.type === "notification.preferences") return;
          if (message.type.startsWith("files.")) {
            await files.handle(message, device);
            return;
          }
          if (message.type === "commands.list" && message.draft) {
            const draft = message.draft;
            if (this.context.draftWorkspace(device, draft.draftId) !== draft.workspaceId)
              throw new Error("draft_unavailable");
            emit({
              type: "commands.list.result",
              requestId: message.requestId,
              commands: listCommands(
                commandCatalog().filter((command) => command.scope !== "runtime"),
                draft.provider,
                message.query,
                message.limit,
              ),
              diagnostics: [],
            });
            return;
          }
          if (message.type === "context.request") {
            emit(await this.context.handle(message, device));
            return;
          }
          if (message.type === "projects.request") {
            const allowed = () => !closed && (this.host.canManageProjects?.(device) ?? true);
            if (!allowed()) {
              emit({
                type: "projects.result",
                requestId: message.requestId,
                result: { kind: "error", code: "forbidden" },
              });
              return;
            }
            const controller = new AbortController();
            if (message.operation.op === "fs.search" || message.operation.op === "fs.complete") {
              picker?.abort();
              picker = controller;
            }
            await Promise.resolve();
            const result = controller.signal.aborted
              ? {
                  type: "projects.result" as const,
                  requestId: message.requestId,
                  result: { kind: "error" as const, code: "search_cancelled" },
                }
              : await this.workspace.projects.read(message, device);
            if (allowed()) emit(result);
            if (picker === controller) picker = undefined;
            return;
          }
          if (message.type === "workspace.request") {
            emit(this.workspace.read(message));
            return;
          }
          if (message.type === "diagnostics.request") {
            emit({
              type: "diagnostics.result",
              requestId: message.requestId,
              ...(message.operation === "doctor"
                ? {
                    report: {
                      at: this.host.now(),
                      checks: [
                        { id: "node", status: "ok", message: "Node v24.0.0", fix: "Update ace." },
                        {
                          id: "git",
                          status: "ok",
                          message: "git version 2.50.0",
                          fix: "Install Git.",
                        },
                        ...this.providerStatuses().map((row) => ({
                          id: `provider.${row.provider}`,
                          status:
                            row.installed && row.auth === "logged_in"
                              ? ("ok" as const)
                              : ("warn" as const),
                          message: row.installed ? "Check provider readiness." : "Not installed.",
                          fix: "Open Settings > Providers.",
                        })),
                        {
                          id: "sqlite",
                          status: "ok",
                          message: "SQLite integrity: ok",
                          fix: "Restore a backup.",
                        },
                      ],
                    },
                  }
                : {
                    toolchains: [
                      {
                        id: "git",
                        available: true,
                        detail: "git version 2.50.0",
                        hint: "Install Git.",
                      },
                      {
                        id: "xcode",
                        available: false,
                        detail: "Simulator tools not found",
                        hint: "Install Xcode from the App Store and open it once to set up the iOS Simulator.",
                      },
                      {
                        id: "android",
                        available: false,
                        detail: "Android SDK not found",
                        hint: "Install Android Studio, then set ANDROID_HOME to its SDK directory.",
                      },
                    ],
                  }),
            });
            return;
          }
          if (message.type === "diagnostics.health") {
            emit({
              type: "diagnostics.health.result",
              requestId: message.requestId,
              ok: true,
              health: fakeHealth(this.host.now(), this.host.threads().length),
            });
            return;
          }
          if (message.type === "pluginRequest") {
            emit(await this.plugins.handle(message));
            if (
              [
                "plugins.accept",
                "plugins.remove",
                "plugins.availability",
                "plugins.skillAvailability",
              ].includes(message.request.type)
            )
              this.catalog.invalidate();
            return;
          }
          if (message.type.startsWith("automation.")) {
            const result = this.automations.handle(message);
            if (result) emit(result);
            return;
          }
          if (message.type === "preview.request") {
            if (!this.host.thread(message.threadId)) throw new Error("thread_not_found");
            const op = message.operation;
            const refusal = this.browser.previewRefusal;
            if (refusal && (op.op === "link" || op.op === "forward")) {
              emit({
                type: "preview.result",
                requestId: message.requestId,
                ok: false,
                error: refusal,
              });
              return;
            }
            if (op.op === "link") {
              // The fake has no gateway: its previews are the servers' own addresses, so the
              // sign-in link is that address and the session never needs renewing.
              const server = this.browser
                .servers(message.threadId)
                .find((candidate) => candidate.port === op.port);
              emit(
                server?.origin
                  ? {
                      type: "preview.result",
                      requestId: message.requestId,
                      ok: true,
                      link: { url: server.origin, sessionMs: 3_600_000 },
                    }
                  : {
                      type: "preview.result",
                      requestId: message.requestId,
                      ok: false,
                      error: "preview_not_found",
                    },
              );
              return;
            }
            if (op.op === "forward")
              this.browser.serve(message.threadId, {
                port: op.port,
                source: "listener",
                origin: `http://127.0.0.1:${op.port}`,
              });
            if (op.op === "unforward") this.browser.unforward(message.threadId, op.port);
            emit({
              type: "preview.result",
              requestId: message.requestId,
              ok: true,
              previews: [...this.browser.servers(message.threadId)],
            });
            return;
          }
          if (message.type === "terminal.credit") {
            terminalStreams.get(message.subscriptionId)?.credit();
            return;
          }
          if (message.type === "terminal.request") {
            const op = message.operation;
            const base = {
              type: "terminal.result" as const,
              requestId: message.requestId,
              ok: true,
            };
            if (op.op === "unsubscribe") {
              subscriptions.get(op.subscriptionId)?.();
              subscriptions.delete(op.subscriptionId);
              emit(base);
              return;
            }
            if (!op.threadId || !this.host.thread(op.threadId)) throw new Error("thread_not_found");
            const terminals = this.workspace.terminals;
            if (op.op === "list") {
              emit({
                ...base,
                terminals: terminals
                  .list(op.threadId)
                  .map((entry) => this.workspace.descriptor(entry.id, op.threadId)),
              });
              return;
            }
            if (op.op === "open") {
              const entry = await terminals.open({
                threadId: op.threadId,
                cwd: this.host.thread(op.threadId)?.thread.details?.worktree ?? "/fake",
                name: op.name,
                cols: op.cols,
                rows: op.rows,
              });
              emit({ ...base, terminal: this.workspace.descriptor(entry.id, op.threadId) });
              return;
            }
            const threadId = op.threadId;
            this.workspace.descriptor(op.terminalId, threadId);
            if (op.op === "write") terminals.write(op.terminalId, op.data);
            if (op.op === "resize") terminals.resize(op.terminalId, op.cols, op.rows);
            if (op.op === "close") terminals.close(op.terminalId);
            if (op.op === "subscribe") {
              if (subscriptions.size >= 8 || subscriptions.has(op.subscriptionId))
                throw new Error("subscription_limit");
              emit(base);
              const stream = new FakeTerminalStream(
                terminals,
                op.terminalId,
                op.fromOffset,
                (event) =>
                  emit({ type: "terminal.output", subscriptionId: op.subscriptionId, event }),
                () => Boolean(this.host.thread(threadId)),
                () => {
                  subscriptions.delete(op.subscriptionId);
                  terminalStreams.delete(op.subscriptionId);
                },
              );
              terminalStreams.set(op.subscriptionId, stream);
              subscriptions.set(op.subscriptionId, () => {
                stream.stop();
                terminalStreams.delete(op.subscriptionId);
              });
              stream.credit();
              return;
            }
            emit(base);
            return;
          }
          const browserMessage = BrowserClientMessage.safeParse(message);
          if (browserMessage.success) {
            await browser.handle(browserMessage.data);
            return;
          }

          replyUnsupported(message, emit);
        } catch (error) {
          if ("requestId" in message)
            emit({
              type: "error",
              requestId: message.requestId,
              code: "service_failed",
              message: error instanceof Error ? error.message : "Service failed",
            });
        }
      },
    };
  }
}
