import {
  BrowserClientMessage,
  ServerMessage,
  type ClientMessage,
  type ServerMessage as Message,
  ConductorCommandPayload,
  type CommandPayload,
  type CommandResult,
  type ForgePrStatus,
} from "@ace/protocol";
import { commandCatalog, listCommands } from "./services/commands.ts";
import { FakeFilesWire } from "./files-wire.ts";
import { FakeBrowser } from "./browser.ts";
import { fakeBrowserSession } from "./browser-wire.ts";
import { FakeTerminalStream } from "./terminal-stream.ts";
import { fakeHealth } from "./health.ts";
import { FakeContextWire } from "./context-wire.ts";
import { FakeWorkspaceWire } from "./workspace-wire.ts";
import { FakeConductor } from "./conductor/fake-conductor.ts";
import { FakePlanningWire, type PlanningSeed } from "./planning-wire.ts";
import { FakePluginsWire, type PluginSeed } from "./plugins-wire.ts";
import type { FakeServiceContext } from "./service-context.ts";
import type { FakeSettings } from "./services/settings.ts";
/** Service state a daemon accumulates over time, which scenario facts can't reach. */
export interface ServicesSeed extends PlanningSeed {
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
 * Per-connection services: context drafts and uploads, workspace reads, health, plugins, Deck
 * and automations, previews, terminals and the browser. Catalog services and settings are
 * `FakeServices`; this reads settings through the same store.
 */
export class FakeServicesWire {
  readonly browser = new FakeBrowser();
  readonly context: FakeContextWire;
  readonly workspace: FakeWorkspaceWire;
  readonly files: FakeFilesWire;
  private planning: FakePlanningWire;
  private plugins = new FakePluginsWire();
  private host: FakeServiceContext;
  private settings: FakeSettings;
  constructor(context: FakeServiceContext, settings: FakeSettings) {
    this.host = context;
    this.files = new FakeFilesWire(context);
    this.settings = settings;
    this.context = new FakeContextWire(context);
    this.workspace = new FakeWorkspaceWire(context);
    this.planning = new FakePlanningWire(
      new FakeConductor({ clock: context.now, runs: [] }),
      context.now,
      () => settings.get("automations.enabled") === true,
      context,
    );
  }
  seed(seed: ServicesSeed): void {
    for (const image of seed.attachmentImages ?? [])
      this.context.seedImage(image.threadId, image.name);
    if (seed.settings) this.settings.seed(seed.settings);
    this.planning.seed(seed);
    if (seed.plugins) this.plugins.seed(seed.plugins);
    // A seed describes the whole world; pull requests for threads this daemon lacks are skipped.
    for (const [threadId, status] of Object.entries(seed.pullRequests ?? {}))
      if (this.host.thread(threadId)) this.workspace.forge.seed(threadId, status);
  }
  failDeck(runId: string, code: string): void {
    this.planning.failDeck(runId, code);
  }
  command(
    payload: CommandPayload,
    commandId?: string,
  ): Omit<CommandResult, "commandId"> | undefined {
    const conductor = ConductorCommandPayload.safeParse(payload);
    if (conductor.success) return this.planning.command(conductor.data);
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
    const files = this.files.session(emit);
    const browser = fakeBrowserSession(this.browser, this.host, emit);
    return {
      authenticated: (device) => {
        owner = device;
      },
      close: () => {
        closed = true;
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
            emit(
              (this.host.canManageProjects?.(device) ?? true)
                ? await this.workspace.projects.read(message, device)
                : {
                    type: "projects.result",
                    requestId: message.requestId,
                    result: { kind: "error", code: "forbidden" },
                  },
            );
            return;
          }
          if (message.type === "workspace.request") {
            emit(this.workspace.read(message));
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
          if (message.type === "conductor.request" || message.type.startsWith("automation.")) {
            const result = this.planning.handle(message, emit, subscriptions);
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
            if (!this.host.thread(op.threadId)) throw new Error("thread_not_found");
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
            this.workspace.descriptor(op.terminalId, op.threadId);
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
                () => Boolean(this.host.thread(op.threadId)),
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
