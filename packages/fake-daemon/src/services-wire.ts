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
import type { FakeServiceContext } from "./service-context.ts";
import type { FakeSettings } from "./services/settings.ts";
/** Service state a daemon accumulates over time, which scenario facts can't reach. */
export interface ServicesSeed extends AutomationSeed {
  /** Seed the small PNG fixture for scoped client attachment reads. */
  attachmentImages?: { threadId: string; name?: string }[];
  plugins?: PluginSeed;
  /** Pull requests linked to existing threads, by thread id. */
  pullRequests?: Record<string, ForgePrStatus>;
  /** Global settings the person has changed from the shipped defaults. */
  settings?: Readonly<Record<string, unknown>>;
}
export interface FakeWireSession {
  authenticated?(device: string): void;
  handle(message: ClientMessage, device: string): Promise<void>;
  close(): void;
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
  readonly browser = new FakeBrowser();
  readonly context: FakeContextWire;
  readonly workspace: FakeWorkspaceWire;
  readonly files: FakeFilesWire;
  private automations: FakeAutomationWire;
  private plugins = new FakePluginsWire();
  private connectionSequence = 0;
  private host: FakeServiceContext;
  private settings: FakeSettings;
  constructor(context: FakeServiceContext, settings: FakeSettings) {
    this.host = context;
    bindFakeBrowserOrigins(this.browser, context, settings);
    this.files = new FakeFilesWire(context);
    this.settings = settings;
    this.context = new FakeContextWire(context);
    this.workspace = new FakeWorkspaceWire(context);
    this.automations = new FakeAutomationWire(
      context.now,
      () => settings.get("automations.enabled") === true,
      context,
    );
  }
  seed(seed: ServicesSeed): void {
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
    const browser = fakeBrowserSession(
      this.browser,
      this.host,
      emit,
      `fake-browser-${++this.connectionSequence}`,
    );
    return {
      authenticated: (device) => {
        owner = device;
      },
      close: () => {
        closed = true;
        picker?.abort();
        stopProjects();

        browser.close();
        files.close();
        for (const stop of subscriptions.values()) stop();
        subscriptions.clear();
        terminalStreams.clear();
      },
      handle: async (message, device) => {
        try {
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
          if (message.type === "history.import" || message.type === "history.continue") {
            if (message.requestId)
              for (const phase of ["preparing", "unsupported"] as const)
                emit({
                  type: "history.operation.progress",
                  requestId: message.requestId,
                  operation: message.type,
                  phase,
                });
            emit({
              type: message.type,
              requestId: message.requestId,
              status: "unsupported",
              reason: "No native history sessions in this fixture",
            });
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
                        {
                          id: "provider.claude",
                          status: "warn",
                          message: "Sign-in needed",
                          fix: "Sign in.",
                        },
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
