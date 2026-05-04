import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationGetSnapshotInput,
  type OrchestrationReadModel,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetThreadError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  FilesystemBrowseError,
  ProjectCreateEntryError,
  ProjectDeleteEntryError,
  ProjectSearchEntriesError,
  ProjectListTreeError,
  ProjectReadFileError,
  ProjectRenameEntryError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type TerminalEvent,
  type BrowserBridgeRequest,
  ServerLspToolsError,
  ServerProviderCliUpgradeError,
  WorkspaceEditorCloseBufferError,
  WorkspaceEditorCompleteError,
  WorkspaceEditorDefinitionError,
  WorkspaceEditorReferencesError,
  WorkspaceEditorSyncBufferError,
  WS_METHODS,
  WsRpcGroup,
} from "@ace/contracts";
import {
  extractWebSocketAuthTokenFromProtocolHeader,
  extractWebSocketClientSessionIdFromProtocolHeader,
  extractWebSocketConnectionIdFromProtocolHeader,
} from "@ace/shared/wsAuth";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { browserBridge } from "./browserBridge";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { runIosSimulatorBridgeRequest } from "./iosSimulatorBridge";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { createReadModelSnapshotViewCache } from "./orchestration/readModelSnapshotView";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { startOpenCodeServer } from "./provider/opencodeRuntime";
import { OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT, searchOpenCodeModels } from "./provider/opencodeSdk";
import { upgradeProviderCli } from "./provider/providerCliUpgrade";
import { withProviderExtensionSlashCommands } from "./provider/providerExtensionSlashCommands";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { RelayHostManagerService } from "./relayHostManager";
import {
  getLspToolsStatus,
  installLspTool,
  installLspTools,
  searchLspMarketplace,
} from "./lspTools";
import { collectRuntimeProfileSnapshot } from "./runtimeProfile";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceEditor } from "./workspace/Services/WorkspaceEditor";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
} from "./workspace/Services/WorkspaceFileSystem";
import {
  WorkspacePathOutsideRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
} from "./workspace/Services/WorkspacePaths";
import {
  disconnectWsClientSession,
  hasActiveWsClientSessions,
  isCurrentWsClientSession,
  registerWsClientSession,
} from "./wsClientSessions";

const WS_UPGRADE_RATE_LIMIT_WINDOW_MS = 60_000;
const WS_UPGRADE_RATE_LIMIT_MAX_ATTEMPTS = 30;
const PROVIDER_AUTO_REFRESH_TICK_MS = 60_000;
const PROVIDER_AUTO_REFRESH_READY_TTL_MS = 2 * 60 * 60_000;
const PROVIDER_AUTO_REFRESH_WARNING_TTL_MS = 45 * 60_000;
const PROVIDER_AUTO_REFRESH_ERROR_TTL_MS = 15 * 60_000;
const ORCHESTRATION_EVENT_REORDER_MAX_PENDING = Math.max(
  128,
  Number.parseInt(process.env.ACE_ORCHESTRATION_EVENT_REORDER_MAX_PENDING ?? "1024", 10) || 1024,
);

function normalizeStreamIdentity(input: {
  readonly clientSessionId?: string | undefined;
  readonly connectionId?: string | undefined;
}): {
  readonly clientSessionId: string | undefined;
  readonly connectionId: string | undefined;
} {
  return {
    clientSessionId: input.clientSessionId,
    connectionId: input.connectionId,
  };
}

function offerBrowserBridgeRequest<TError>(
  queue: Queue.Queue<BrowserBridgeRequest, TError>,
  request: BrowserBridgeRequest,
): void {
  void Effect.runPromise(Queue.offer(queue, request).pipe(Effect.asVoid));
}

function resolveWsRateLimitKey(headers: Record<string, string | undefined>): string {
  const clientSessionId = extractWebSocketClientSessionIdFromProtocolHeader(
    headers["sec-websocket-protocol"],
  );
  if (clientSessionId) {
    return `ws-client:${clientSessionId}`;
  }
  const forwardedFor = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  if (forwardedFor) {
    return forwardedFor;
  }

  const realIp = headers["x-real-ip"]?.trim();
  if (realIp) {
    return realIp;
  }

  return headers["user-agent"]?.trim() || "ws-upgrade:unknown";
}

function providerRefreshJitterFactor(provider: ProviderKind): number {
  let hash = 0;
  for (let index = 0; index < provider.length; index += 1) {
    hash = (hash << 5) - hash + provider.charCodeAt(index);
    hash |= 0;
  }
  const normalized = Math.abs(hash % 100) / 100;
  return 0.8 + normalized * 0.5;
}

function providerRefreshBaseTtlMs(status: ServerProvider["status"]): number {
  switch (status) {
    case "ready":
      return PROVIDER_AUTO_REFRESH_READY_TTL_MS;
    case "warning":
      return PROVIDER_AUTO_REFRESH_WARNING_TTL_MS;
    case "error":
      return PROVIDER_AUTO_REFRESH_ERROR_TTL_MS;
    case "disabled":
      return Number.MAX_SAFE_INTEGER;
  }
}

function isPendingProviderSnapshot(provider: ServerProvider): boolean {
  return (
    provider.status === "warning" &&
    provider.message !== undefined &&
    provider.message.toLowerCase().startsWith("checking ")
  );
}

function providerRefreshDueAt(provider: ServerProvider): number {
  if (isPendingProviderSnapshot(provider)) {
    return 0;
  }
  const checkedAtMs = Date.parse(provider.checkedAt);
  const baseTtlMs = providerRefreshBaseTtlMs(provider.status);
  const ttlMs = Math.round(baseTtlMs * providerRefreshJitterFactor(provider.provider));
  if (!Number.isFinite(checkedAtMs)) {
    return 0;
  }
  return checkedAtMs + ttlMs;
}

function selectDueProviderForRefresh(
  providers: ReadonlyArray<ServerProvider>,
  now = Date.now(),
): ProviderKind | null {
  const dueProviders = providers
    .filter((provider) => provider.enabled && provider.status !== "disabled")
    .map((provider) => ({ provider: provider.provider, dueAt: providerRefreshDueAt(provider) }))
    .filter((provider) => provider.dueAt <= now);

  if (dueProviders.length === 0) {
    return null;
  }

  const oldestDueAt = dueProviders.reduce(
    (oldest, provider) => (provider.dueAt < oldest ? provider.dueAt : oldest),
    dueProviders[0]!.dueAt,
  );
  const oldestDueProviders = dueProviders.filter((provider) => provider.dueAt === oldestDueAt);
  const selectedIndex = Math.floor(Math.random() * oldestDueProviders.length);
  return oldestDueProviders[selectedIndex]?.provider ?? null;
}

function hasExplicitSnapshotHydrationMode(
  input: OrchestrationGetSnapshotInput | undefined,
): input is OrchestrationGetSnapshotInput & { readonly hydrateThreadId: ThreadId | null } {
  return input !== undefined && Object.prototype.hasOwnProperty.call(input, "hydrateThreadId");
}

function replaceSnapshotThread(
  snapshot: OrchestrationReadModel,
  threadId: OrchestrationReadModel["threads"][number]["id"],
  nextThread: OrchestrationReadModel["threads"][number],
): OrchestrationReadModel {
  const threadIndex = snapshot.threads.findIndex((thread) => thread.id === threadId);
  if (threadIndex === -1) {
    return snapshot;
  }
  if (snapshot.threads[threadIndex] === nextThread) {
    return snapshot;
  }

  const threads = snapshot.threads.slice();
  threads[threadIndex] = nextThread;
  return {
    ...snapshot,
    threads,
    updatedAt:
      snapshot.updatedAt.localeCompare(nextThread.updatedAt) >= 0
        ? snapshot.updatedAt
        : nextThread.updatedAt,
  };
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    const providerServiceOption = yield* Effect.serviceOption(ProviderService);
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const relayHostManager = yield* RelayHostManagerService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceEditor = yield* WorkspaceEditor;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const snapshotViewCache = createReadModelSnapshotViewCache();

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const settings = yield* serverSettings.getSettings;
      const providers = withProviderExtensionSlashCommands({
        providers: yield* providerRegistry.getProviders,
        cwd: config.cwd,
        settings,
      });

      return {
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors: resolveAvailableEditors(),
        settings,
        relay: yield* relayHostManager.getStatus,
      };
    });

    const withCurrentProviderCommands = (providers: ReadonlyArray<ServerProvider>) =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) =>
          withProviderExtensionSlashCommands({
            providers,
            cwd: config.cwd,
            settings,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to discover provider extension commands", {
            error: error.message,
          }).pipe(Effect.as(providers)),
        ),
      );

    const loadRuntimeProfile = Effect.gen(function* () {
      const providerSessions = Option.isSome(providerServiceOption)
        ? yield* providerServiceOption.value.listSessions()
        : [];
      const sessionCountByProvider = new Map<ProviderKind, number>();
      for (const session of providerSessions) {
        const currentCount = sessionCountByProvider.get(session.provider) ?? 0;
        sessionCountByProvider.set(session.provider, currentCount + 1);
      }
      const providerSessionCounts = [...sessionCountByProvider.entries()]
        .map(([provider, sessionCount]) => ({ provider, sessionCount }))
        .toSorted((left, right) => left.provider.localeCompare(right.provider));
      return collectRuntimeProfileSnapshot({
        providerSessions: providerSessionCounts,
      });
    });

    const refreshOneProviderWhenDue = Effect.gen(function* () {
      if (!hasActiveWsClientSessions()) {
        return;
      }
      const providers = yield* providerRegistry.getProviders;
      const providerToRefresh = selectDueProviderForRefresh(providers);
      if (!providerToRefresh) {
        return;
      }
      const providerServiceOption = yield* Effect.serviceOption(ProviderService);
      if (Option.isSome(providerServiceOption)) {
        const providerSessions = yield* providerServiceOption.value.listSessions();
        if (providerSessions.some((session) => session.provider === providerToRefresh)) {
          return;
        }
      }
      yield* providerRegistry.refresh(providerToRefresh);
    });

    const getProviderBinaryPath = (provider: ProviderKind) =>
      serverSettings.getSettings.pipe(
        Effect.flatMap((settings) => {
          switch (provider) {
            case "codex":
              return Effect.succeed(settings.providers.codex.binaryPath);
            case "gemini":
              return Effect.succeed(settings.providers.gemini.binaryPath);
            default:
              return Effect.fail(
                new ServerProviderCliUpgradeError({
                  message: "One-click upgrade is not supported for this provider.",
                }),
              );
          }
        }),
        Effect.mapError(
          (cause) =>
            new ServerProviderCliUpgradeError({
              message: "Unable to read provider settings before upgrading the CLI.",
              cause,
            }),
        ),
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(PROVIDER_AUTO_REFRESH_TICK_MS).pipe(
          Effect.flatMap(() => refreshOneProviderWhenDue),
          Effect.ignoreCause({ log: true }),
        ),
      ),
    );

    const filterCurrentClientStream = <TValue, TError, TContext>(
      input: {
        readonly clientSessionId: string | undefined;
        readonly connectionId: string | undefined;
      },
      stream: Stream.Stream<TValue, TError, TContext>,
    ): Stream.Stream<TValue, TError, TContext> =>
      stream.pipe(
        Stream.filter(() => isCurrentWsClientSession(input.clientSessionId, input.connectionId)),
      );

    const loadSnapshot = (input?: OrchestrationGetSnapshotInput) =>
      Effect.gen(function* () {
        if (!hasExplicitSnapshotHydrationMode(input)) {
          return yield* projectionSnapshotQuery.getSnapshot(input);
        }

        const readModel = yield* orchestrationEngine.getReadModel();
        const snapshot = snapshotViewCache.getSnapshot(readModel, input);
        const hydrateThreadId = input.hydrateThreadId ?? null;
        if (hydrateThreadId === null) {
          return snapshot;
        }

        const hydratedThread = yield* projectionSnapshotQuery.getThread(hydrateThreadId);
        return Option.match(hydratedThread, {
          onNone: () => snapshot,
          onSome: (thread) => replaceSnapshotThread(snapshot, hydrateThreadId, thread),
        });
      });

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (input) =>
        loadSnapshot(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getThread]: (input) =>
        projectionSnapshotQuery.getThread(input.threadId).pipe(
          Effect.flatMap((thread) =>
            Option.match(thread, {
              onNone: () =>
                Effect.fail(
                  new OrchestrationGetThreadError({
                    message: `Thread '${input.threadId}' was not found.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError((cause) =>
            Schema.is(OrchestrationGetThreadError)(cause)
              ? cause
              : new OrchestrationGetThreadError({
                  message: "Failed to load orchestration thread",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        Effect.gen(function* () {
          const normalizedCommand = yield* normalizeDispatchCommand(command);
          return yield* startup.enqueueCommand(orchestrationEngine.dispatch(normalizedCommand));
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
            );
            const replayStream = Stream.fromIterable(replayEvents);
            const source = Stream.merge(replayStream, orchestrationEngine.streamDomainEvents);
            type SequenceState = {
              readonly nextSequence: number;
              readonly pendingBySequence: Map<number, OrchestrationEvent>;
            };
            const state = yield* Ref.make<SequenceState>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, OrchestrationEvent>(),
            });

            return source.pipe(
              Stream.filter(() =>
                isCurrentWsClientSession(input.clientSessionId, input.connectionId),
              ),
              Stream.mapEffect((event) =>
                Ref.modify(
                  state,
                  ({
                    nextSequence,
                    pendingBySequence,
                  }): [Array<OrchestrationEvent>, SequenceState] => {
                    if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                      return [[], { nextSequence, pendingBySequence }];
                    }

                    pendingBySequence.set(event.sequence, event);

                    const emit: Array<OrchestrationEvent> = [];
                    let expected = nextSequence;
                    for (;;) {
                      const expectedEvent = pendingBySequence.get(expected);
                      if (!expectedEvent) {
                        break;
                      }
                      emit.push(expectedEvent);
                      pendingBySequence.delete(expected);
                      expected += 1;
                    }

                    if (pendingBySequence.size > ORCHESTRATION_EVENT_REORDER_MAX_PENDING) {
                      let newestPendingEvent: OrchestrationEvent | null = null;
                      for (const pendingEvent of pendingBySequence.values()) {
                        if (
                          newestPendingEvent === null ||
                          pendingEvent.sequence > newestPendingEvent.sequence
                        ) {
                          newestPendingEvent = pendingEvent;
                        }
                      }
                      pendingBySequence.clear();
                      if (newestPendingEvent !== null) {
                        emit.push(newestPendingEvent);
                        expected = newestPendingEvent.sequence + 1;
                      }
                    }

                    return [emit, { nextSequence: expected, pendingBySequence }];
                  },
                ),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );
          }),
        ),
      [WS_METHODS.serverGetConfig]: (_input) => loadServerConfig,
      [WS_METHODS.serverPickFolder]: (input) => open.pickFolder(input),
      [WS_METHODS.serverRefreshProviders]: (_input) =>
        providerRegistry.refresh().pipe(
          Effect.flatMap(withCurrentProviderCommands),
          Effect.map((providers) => ({ providers })),
        ),
      [WS_METHODS.serverUpgradeProviderCli]: (input) =>
        Effect.gen(function* () {
          const binaryPath = yield* getProviderBinaryPath(input.provider);
          yield* upgradeProviderCli({ provider: input.provider, binaryPath });
          const providers = yield* providerRegistry
            .refresh(input.provider)
            .pipe(Effect.flatMap(withCurrentProviderCommands));
          return { providers };
        }),
      [WS_METHODS.serverGetRuntimeProfile]: (_input) => loadRuntimeProfile,
      [WS_METHODS.serverSearchOpenCodeModels]: (input) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
          if (!settings.providers.opencode.enabled) {
            return {
              models: [],
              totalModels: 0,
              nextOffset: null,
              hasMore: false,
            };
          }

          return yield* Effect.promise(async () => {
            const server = await startOpenCodeServer(settings.providers.opencode.binaryPath);
            try {
              return await searchOpenCodeModels(server.url, {
                query: input.query,
                limit: clamp(input.limit, {
                  minimum: 1,
                  maximum: OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT,
                }),
                offset: clamp(input.offset, { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
              });
            } finally {
              await server.close();
            }
          }).pipe(Effect.orDie);
        }),
      [WS_METHODS.serverGetLspToolsStatus]: (_input) =>
        Effect.tryPromise({
          try: () => getLspToolsStatus(config.stateDir),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to load language server installation status.",
              cause,
            }),
        }),
      [WS_METHODS.serverInstallLspTools]: (input) =>
        Effect.tryPromise({
          try: () =>
            installLspTools(
              config.stateDir,
              input.reinstall === undefined ? {} : { reinstall: input.reinstall },
            ),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to install language server tools.",
              cause,
            }),
        }),
      [WS_METHODS.serverSearchLspMarketplace]: (input) =>
        Effect.tryPromise({
          try: () => searchLspMarketplace(input.query, input.limit),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to search language server marketplace.",
              cause,
            }),
        }),
      [WS_METHODS.serverInstallLspTool]: (input) =>
        Effect.tryPromise({
          try: () => installLspTool(config.stateDir, input),
          catch: (cause) =>
            new ServerLspToolsError({
              message: "Unable to install language server tool.",
              cause,
            }),
        }),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
          return { keybindings: keybindingsConfig, issues: [] };
        }),
      [WS_METHODS.serverGetSettings]: (_input) => serverSettings.getSettings,
      [WS_METHODS.serverUpdateSettings]: ({ patch }) => serverSettings.updateSettings(patch),
      [WS_METHODS.serverDisconnect]: (input) =>
        Effect.sync(() => {
          disconnectWsClientSession(input.clientSessionId, input.connectionId);
          return {};
        }),
      [WS_METHODS.browserBridgeResolve]: (input) =>
        Effect.sync(() => {
          browserBridge.resolve(input);
          return {};
        }),
      [WS_METHODS.browserRunSimulatorOperation]: (input) =>
        Effect.tryPromise({
          try: () => runIosSimulatorBridgeRequest(input),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error("Unable to run iOS simulator operation."),
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        workspaceEntries.search(input).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectSearchEntriesError({
                message: `Failed to search workspace entries: ${cause.detail}`,
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsListTree]: (input) =>
        workspaceEntries.listTree(input.cwd).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectListTreeError({
                message: `Failed to load workspace tree: ${cause.detail}`,
                cause,
              }),
          ),
        ),
      [WS_METHODS.projectsCreateEntry]: (input) =>
        workspaceFileSystem.createEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectCreateEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsDeleteEntry]: (input) =>
        workspaceFileSystem.deleteEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectDeleteEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsReadFile]: (input) =>
        workspaceFileSystem.readFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectReadFileError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsRenameEntry]: (input) =>
        workspaceFileSystem.renameEntry(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectRenameEntryError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        workspaceFileSystem.writeFile(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : cause.detail;
            return new ProjectWriteFileError({
              conflict: Schema.is(WorkspaceFileSystemError)(cause) ? cause.conflict : undefined,
              currentContents: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.currentContents
                : undefined,
              currentVersion: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.currentVersion
                : undefined,
              expectedVersion: Schema.is(WorkspaceFileSystemError)(cause)
                ? cause.expectedVersion
                : undefined,
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorSyncBuffer]: (input) =>
        workspaceEditor.syncBuffer(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to sync workspace diagnostics.";
            return new WorkspaceEditorSyncBufferError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorCloseBuffer]: (input) =>
        workspaceEditor.closeBuffer(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to close the workspace diagnostics buffer.";
            return new WorkspaceEditorCloseBufferError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorComplete]: (input) =>
        workspaceEditor.complete(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to load workspace completions.";
            return new WorkspaceEditorCompleteError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorDefinition]: (input) =>
        workspaceEditor.definition(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to resolve workspace definitions.";
            return new WorkspaceEditorDefinitionError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.workspaceEditorReferences]: (input) =>
        workspaceEditor.references(input).pipe(
          Effect.mapError((cause) => {
            const message = Schema.is(WorkspacePathOutsideRootError)(cause)
              ? "Workspace file path must stay within the project root."
              : Schema.is(WorkspaceRootNotExistsError)(cause) ||
                  Schema.is(WorkspaceRootNotDirectoryError)(cause)
                ? cause.message
                : "Failed to resolve workspace references.";
            return new WorkspaceEditorReferencesError({
              message,
              cause,
            });
          }),
        ),
      [WS_METHODS.shellOpenInEditor]: (input) => open.openInEditor(input),
      [WS_METHODS.shellRevealInFileManager]: (input) => open.revealInFileManager(input),
      [WS_METHODS.shellPathExists]: (input) => open.pathExists(input),
      [WS_METHODS.filesystemBrowse]: (input) =>
        workspaceEntries.browse(input).pipe(
          Effect.mapError(
            (cause) =>
              new FilesystemBrowseError({
                message: cause.detail,
                cause,
              }),
          ),
        ),
      [WS_METHODS.gitStatus]: (input) => gitManager.status(input),
      [WS_METHODS.gitReadWorkingTreeDiff]: (input) => gitManager.readWorkingTreeDiff(input),
      [WS_METHODS.gitPull]: (input) => git.pullCurrentBranch(input.cwd),
      [WS_METHODS.gitRunStackedAction]: (input) =>
        Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
          gitManager
            .runStackedAction(input, {
              actionId: input.actionId,
              progressReporter: {
                publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
              },
            })
            .pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
              }),
            ),
        ),
      [WS_METHODS.gitResolvePullRequest]: (input) => gitManager.resolvePullRequest(input),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        gitManager.preparePullRequestThread(input),
      [WS_METHODS.gitListBranches]: (input) => git.listBranches(input),
      [WS_METHODS.gitListGitHubIssues]: (input) => gitManager.listGitHubIssues(input),
      [WS_METHODS.gitGetGitHubIssueThread]: (input) => gitManager.getGitHubIssueThread(input),
      [WS_METHODS.gitCreateWorktree]: (input) => git.createWorktree(input),
      [WS_METHODS.gitRemoveWorktree]: (input) => git.removeWorktree(input),
      [WS_METHODS.gitCreateBranch]: (input) => git.createBranch(input),
      [WS_METHODS.gitCheckout]: (input) => Effect.scoped(git.checkoutBranch(input)),
      [WS_METHODS.gitInit]: (input) => git.initRepo(input),
      [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
      [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
      [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
      [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
      [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
      [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
      [WS_METHODS.subscribeTerminalEvents]: (input) =>
        filterCurrentClientStream(
          normalizeStreamIdentity(input),
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        ),
      [WS_METHODS.subscribeBrowserBridgeRequests]: (input) =>
        filterCurrentClientStream(
          normalizeStreamIdentity(input),
          Stream.callback<BrowserBridgeRequest>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                browserBridge.subscribe((request) => {
                  offerBrowserBridgeRequest(queue, request);
                }),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        ),
      [WS_METHODS.subscribeServerConfig]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = providerRegistry.streamChanges.pipe(
              Stream.mapEffect(withCurrentProviderCommands),
              Stream.map((providers) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers },
              })),
            );
            const settingsUpdates = serverSettings.streamChanges.pipe(
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );
            const relayUpdates = relayHostManager.streamChanges.pipe(
              Stream.map((relay) => ({
                version: 1 as const,
                type: "relayUpdated" as const,
                payload: { relay },
              })),
            );

            return filterCurrentClientStream(
              normalizeStreamIdentity(input),
              Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                Stream.merge(
                  keybindingsUpdates,
                  Stream.merge(providerStatuses, Stream.merge(settingsUpdates, relayUpdates)),
                ),
              ),
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return filterCurrentClientStream(
              normalizeStreamIdentity(input),
              Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents),
            );
          }),
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const wsUpgradeAttempts = new Map<string, { count: number; resetAt: number }>();
    const websocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup).pipe(
      Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)),
    );

    const takeWsUpgradeBudget = (clientKey: string, now = Date.now()) => {
      for (const [key, value] of wsUpgradeAttempts.entries()) {
        if (value.resetAt <= now) {
          wsUpgradeAttempts.delete(key);
        }
      }

      const current = wsUpgradeAttempts.get(clientKey);
      if (!current || current.resetAt <= now) {
        wsUpgradeAttempts.set(clientKey, {
          count: 1,
          resetAt: now + WS_UPGRADE_RATE_LIMIT_WINDOW_MS,
        });
        return {
          allowed: true,
          retryAfterSeconds: Math.ceil(WS_UPGRADE_RATE_LIMIT_WINDOW_MS / 1_000),
        } as const;
      }

      if (current.count >= WS_UPGRADE_RATE_LIMIT_MAX_ATTEMPTS) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
        } as const;
      }

      current.count += 1;
      return {
        allowed: true,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
      } as const;
    };

    const releaseWsUpgradeBudget = (clientKey: string) => {
      const current = wsUpgradeAttempts.get(clientKey);
      if (!current) {
        return;
      }
      if (current.count <= 1) {
        wsUpgradeAttempts.delete(clientKey);
        return;
      }
      current.count -= 1;
    };

    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const clientKey = resolveWsRateLimitKey(request.headers);
        const rateLimit = takeWsUpgradeBudget(clientKey);
        if (!rateLimit.allowed) {
          return HttpServerResponse.text("Too many WebSocket upgrade attempts", {
            status: 429,
            headers: {
              "Retry-After": String(rateLimit.retryAfterSeconds),
            },
          });
        }
        const clientSessionId = extractWebSocketClientSessionIdFromProtocolHeader(
          request.headers["sec-websocket-protocol"],
        );
        const connectionId = extractWebSocketConnectionIdFromProtocolHeader(
          request.headers["sec-websocket-protocol"],
        );
        const connectionToken =
          extractWebSocketAuthTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]) ??
          "";

        if (config.authToken) {
          if (connectionToken !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }

        if ((clientSessionId && !connectionId) || (!clientSessionId && connectionId)) {
          return HttpServerResponse.text("Invalid WebSocket client identity", { status: 400 });
        }
        releaseWsUpgradeBudget(clientKey);
        if (clientSessionId && connectionId) {
          registerWsClientSession(clientSessionId, connectionId);
        }
        return yield* websocketHttpEffect;
      }),
    );
  }),
);
