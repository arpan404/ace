import {
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
  type OrchestrationEvent,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetSnapshotInput,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectListTreeInput,
  type ProjectListTreeResult,
  type ProjectCreateEntryInput,
  type ProjectCreateEntryResult,
  type ProjectDeleteEntryInput,
  type ProjectDeleteEntryResult,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectRenameEntryInput,
  type ProjectRenameEntryResult,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
  type ServerConfig,
  type ServerInstallLspToolInput,
  type ServerInstallLspToolsInput,
  type ServerLspMarketplaceSearchInput,
  type ServerLspMarketplaceSearchResult,
  type ServerSearchOpenCodeModelsInput,
  type ServerSearchOpenCodeModelsResult,
  type ServerLspToolsStatus,
  type ServerProviderUpdatedPayload,
  type ServerSettings,
  type ServerSettingsPatch,
  type ServerUpsertKeybindingInput,
  type ServerUpsertKeybindingResult,
  DEFAULT_TERMINAL_ID,
  type GitActionProgressEvent,
  type GitCheckoutInput,
  type GitCreateBranchInput,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitGetGitHubIssueThreadInput,
  type GitGetGitHubIssueThreadResult,
  type GitInitInput,
  type GitListGitHubIssuesInput,
  type GitListGitHubIssuesResult,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullInput,
  type GitPullResult,
  type GitPullRequestRefInput,
  type GitRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusInput,
  type GitStatusResult,
  type GitWorkingTreeDiffInput,
  type GitWorkingTreeDiffResult,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
  type ThreadId,
  type WorkspaceEditorCloseBufferInput,
  type WorkspaceEditorCloseBufferResult,
  type WorkspaceEditorCompleteInput,
  type WorkspaceEditorCompleteResult,
  type WorkspaceEditorDefinitionInput,
  type WorkspaceEditorDefinitionResult,
  type WorkspaceEditorReferencesInput,
  type WorkspaceEditorReferencesResult,
  type WorkspaceEditorSyncBufferInput,
  type WorkspaceEditorSyncBufferResult,
  WS_METHODS,
} from "@ace/contracts";
import { parseRelayConnectionUrl } from "@ace/shared/relay";
import { randomUUID } from "@ace/shared/ids";
import { RelayRpcTransport } from "@ace/shared/relayRpcTransport";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsClientConnectionIdentity,
  type WsRpcProtocolClient,
} from "@ace/shared/wsRpcProtocol";
import { Duration, Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { loadMobileRelayDeviceIdentity } from "../relayDeviceIdentity";
import { resolveMobileSecureRelayConnectionUrl } from "../relaySecureStorage";

const DEFAULT_SUBSCRIPTION_RETRY_DELAY = Duration.millis(300);

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveTargetUrl(url: string, authToken?: string): string {
  const parsed = new URL(url);
  if (!authToken) {
    return parsed.toString();
  }
  const trimmedToken = authToken.trim();
  if (trimmedToken.length === 0) {
    return parsed.toString();
  }
  if (!parsed.searchParams.has("token")) {
    parsed.searchParams.set("token", trimmedToken);
  }
  return parsed.toString();
}

export interface MobileWsClientConnectionState {
  readonly kind: "connected" | "disconnected";
  readonly error?: string;
}

interface MobileWsTransportOptions {
  readonly url: string;
  readonly authToken?: string;
  readonly clientSessionId?: string;
}

interface MobileRpcTransportLike {
  readonly dispose: () => Promise<void>;
  readonly getConnectionIdentity: () => WsClientConnectionIdentity;
  readonly onConnectionStateChange: (
    listener: (state: MobileWsClientConnectionState) => void,
  ) => () => void;
  readonly request: <TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ) => Promise<TSuccess>;
  readonly requestStream: <TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ) => Promise<void>;
  readonly subscribe: <TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ) => () => void;
}

class MobileWsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private readonly identity: WsClientConnectionIdentity;
  private readonly connectionStateListeners = new Set<
    (state: MobileWsClientConnectionState) => void
  >();
  private disposed = false;
  private hasConnected = false;
  private disconnected = false;

  constructor(options: MobileWsTransportOptions) {
    this.identity = {
      clientSessionId: options.clientSessionId?.trim() || randomUUID(),
      connectionId: randomUUID(),
    };

    const target = resolveTargetUrl(options.url, options.authToken);
    this.runtime = ManagedRuntime.make(
      createWsRpcProtocolLayer({
        target,
        identity: this.identity,
      }),
    );
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  getConnectionIdentity(): WsClientConnectionIdentity {
    return { ...this.identity };
  }

  onConnectionStateChange(listener: (state: MobileWsClientConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private emitConnectionState(state: MobileWsClientConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break transport lifecycle.
      }
    }
  }

  private noteConnected(): void {
    if (!this.hasConnected) {
      this.hasConnected = true;
      this.disconnected = false;
      this.emitConnectionState({ kind: "connected" });
      return;
    }
    if (!this.disconnected) {
      return;
    }
    this.disconnected = false;
    this.emitConnectionState({ kind: "connected" });
  }

  private noteDisconnected(error: unknown): void {
    if (!this.hasConnected || this.disconnected || this.disposed) {
      return;
    }
    this.disconnected = true;
    this.emitConnectionState({
      kind: "disconnected",
      error: formatErrorMessage(error),
    });
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    const client = await this.clientPromise;
    const result = await this.runtime.runPromise(Effect.suspend(() => execute(client)));
    this.noteConnected();
    return result;
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    const client = await this.clientPromise;
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          if (!this.disposed) {
            listener(value);
          }
        }),
      ),
    );
    this.noteConnected();
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Effect.sync(() => {
            this.noteConnected();
          }).pipe(
            Effect.andThen(
              Stream.runForEach(connect(client), (value) =>
                Effect.sync(() => {
                  if (!active) {
                    return;
                  }
                  try {
                    listener(value);
                  } catch {
                    // Listener errors are isolated so stream retries remain active.
                  }
                }),
              ),
            ),
            Effect.tap(() =>
              active && !this.disposed
                ? Effect.sync(() => {
                    this.noteDisconnected(new Error("Subscription ended"));
                  })
                : Effect.void,
            ),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          this.noteDisconnected(error);
          return Effect.sleep(DEFAULT_SUBSCRIPTION_RETRY_DELAY);
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const clientPromise = Reflect.get(this, "clientPromise") as
      | Promise<WsRpcProtocolClient>
      | undefined;
    const client =
      clientPromise && this.hasConnected
        ? await Promise.race([
            clientPromise.catch(() => undefined),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
          ])
        : undefined;
    if (client && this.hasConnected) {
      await Promise.race([
        this.runtime
          .runPromise(
            Effect.suspend(() =>
              client[WS_METHODS.serverDisconnect]({
                clientSessionId: this.identity.clientSessionId,
                connectionId: this.identity.connectionId,
              }),
            ),
          )
          .catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    }
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}

export interface MobileWsClient {
  readonly identity: WsClientConnectionIdentity;
  readonly dispose: () => Promise<void>;
  readonly onConnectionStateChange: (
    listener: (state: MobileWsClientConnectionState) => void,
  ) => () => void;
  readonly server: {
    readonly getConfig: () => Promise<ServerConfig>;
    readonly refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    readonly getLspToolsStatus: () => Promise<ServerLspToolsStatus>;
    readonly installLspTools: (input?: ServerInstallLspToolsInput) => Promise<ServerLspToolsStatus>;
    readonly searchLspMarketplace: (
      input: ServerLspMarketplaceSearchInput,
    ) => Promise<ServerLspMarketplaceSearchResult>;
    readonly installLspTool: (input: ServerInstallLspToolInput) => Promise<ServerLspToolsStatus>;
    readonly searchOpenCodeModels: (
      input: ServerSearchOpenCodeModelsInput,
    ) => Promise<ServerSearchOpenCodeModelsResult>;
    readonly upsertKeybinding: (
      input: ServerUpsertKeybindingInput,
    ) => Promise<ServerUpsertKeybindingResult>;
    readonly getSettings: () => Promise<ServerSettings>;
    readonly updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  };
  readonly projects: {
    readonly searchEntries: (
      input: ProjectSearchEntriesInput,
    ) => Promise<ProjectSearchEntriesResult>;
    readonly listTree: (input: ProjectListTreeInput) => Promise<ProjectListTreeResult>;
    readonly createEntry: (input: ProjectCreateEntryInput) => Promise<ProjectCreateEntryResult>;
    readonly deleteEntry: (input: ProjectDeleteEntryInput) => Promise<ProjectDeleteEntryResult>;
    readonly readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    readonly renameEntry: (input: ProjectRenameEntryInput) => Promise<ProjectRenameEntryResult>;
    readonly writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  readonly filesystem: {
    readonly browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  readonly workspaceEditor: {
    readonly syncBuffer: (
      input: WorkspaceEditorSyncBufferInput,
    ) => Promise<WorkspaceEditorSyncBufferResult>;
    readonly closeBuffer: (
      input: WorkspaceEditorCloseBufferInput,
    ) => Promise<WorkspaceEditorCloseBufferResult>;
    readonly complete: (
      input: WorkspaceEditorCompleteInput,
    ) => Promise<WorkspaceEditorCompleteResult>;
    readonly definition: (
      input: WorkspaceEditorDefinitionInput,
    ) => Promise<WorkspaceEditorDefinitionResult>;
    readonly references: (
      input: WorkspaceEditorReferencesInput,
    ) => Promise<WorkspaceEditorReferencesResult>;
  };
  readonly git: {
    readonly status: (input: GitStatusInput) => Promise<GitStatusResult>;
    readonly readWorkingTreeDiff: (
      input: GitWorkingTreeDiffInput,
    ) => Promise<GitWorkingTreeDiffResult>;
    readonly listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    readonly createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    readonly removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    readonly createBranch: (input: GitCreateBranchInput) => Promise<void>;
    readonly listGitHubIssues: (
      input: GitListGitHubIssuesInput,
    ) => Promise<GitListGitHubIssuesResult>;
    readonly getGitHubIssueThread: (
      input: GitGetGitHubIssueThreadInput,
    ) => Promise<GitGetGitHubIssueThreadResult>;
    readonly checkout: (input: GitCheckoutInput) => Promise<void>;
    readonly init: (input: GitInitInput) => Promise<void>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Promise<GitResolvePullRequestResult>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    readonly pull: (input: GitPullInput) => Promise<GitPullResult>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: { readonly onProgress?: (event: GitActionProgressEvent) => void },
    ) => Promise<GitRunStackedActionResult>;
  };
  readonly terminal: {
    readonly open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    readonly write: (input: TerminalWriteInput) => Promise<void>;
    readonly resize: (input: TerminalResizeInput) => Promise<void>;
    readonly clear: (input: TerminalClearInput) => Promise<void>;
    readonly restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    readonly close: (input: TerminalCloseInput) => Promise<void>;
    readonly onEvent: (listener: (event: TerminalEvent) => void) => () => void;
  };
  readonly orchestration: {
    readonly getSnapshot: (
      input?: OrchestrationGetSnapshotInput,
    ) => Promise<OrchestrationReadModel>;
    readonly getThread: (threadId: ThreadId) => Promise<OrchestrationThread>;
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    readonly dispatchCommand: (
      command: ClientOrchestrationCommand,
    ) => Promise<{ sequence: number }>;
    readonly onDomainEvent: (listener: (event: OrchestrationEvent) => void) => () => void;
  };
}

function createRelayConnectionId(): string {
  return `mobile-connection-${randomUUID()}`;
}

function createMobileTransport(options: MobileWsTransportOptions): MobileRpcTransportLike {
  if (!parseRelayConnectionUrl(options.url)) {
    return new MobileWsTransport(options);
  }
  const transport = new RelayRpcTransport({
    connectionUrl: options.url,
    clientSessionId: options.clientSessionId?.trim() || randomUUID(),
    connectionId: createRelayConnectionId(),
    deviceName: "ace mobile",
    loadIdentity: loadMobileRelayDeviceIdentity,
    resolveConnectionUrl: resolveMobileSecureRelayConnectionUrl,
  });
  return {
    dispose: () => transport.dispose(),
    getConnectionIdentity: () => transport.getConnectionIdentity(),
    onConnectionStateChange: (listener) =>
      transport.onConnectionStateChange((state) => {
        if (state.kind === "disconnected") {
          listener({
            kind: "disconnected",
            ...(state.error ? { error: state.error } : {}),
          });
          return;
        }
        listener({ kind: "connected" });
      }),
    request: (execute) => transport.request(execute),
    requestStream: (connect, listener) => transport.requestStream(connect, listener),
    subscribe: (connect, listener) => transport.subscribe(connect, listener),
  };
}

export function createMobileWsClient(options: MobileWsTransportOptions): MobileWsClient {
  const transport = createMobileTransport(options);
  const streamIdentity = transport.getConnectionIdentity();
  const withTerminalId = <
    T extends Record<string, unknown> & { readonly terminalId?: string | undefined },
  >(
    input: T,
  ): Omit<T, "terminalId"> & { readonly terminalId: string } => ({
    ...input,
    terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
  });
  return {
    identity: streamIdentity,
    dispose: () => transport.dispose(),
    onConnectionStateChange: (listener) => transport.onConnectionStateChange(listener),
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      getLspToolsStatus: () =>
        transport.request((client) => client[WS_METHODS.serverGetLspToolsStatus]({})),
      installLspTools: (input) =>
        transport.request((client) => client[WS_METHODS.serverInstallLspTools](input ?? {})),
      searchLspMarketplace: (input) =>
        transport.request((client) => client[WS_METHODS.serverSearchLspMarketplace](input)),
      installLspTool: (input) =>
        transport.request((client) => client[WS_METHODS.serverInstallLspTool](input)),
      searchOpenCodeModels: (input) =>
        transport.request((client) => client[WS_METHODS.serverSearchOpenCodeModels](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      listTree: (input) =>
        transport.request((client) => client[WS_METHODS.projectsListTree](input)),
      createEntry: (input) =>
        transport.request((client) => client[WS_METHODS.projectsCreateEntry](input)),
      deleteEntry: (input) =>
        transport.request((client) => client[WS_METHODS.projectsDeleteEntry](input)),
      readFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadFile](input)),
      renameEntry: (input) =>
        transport.request((client) => client[WS_METHODS.projectsRenameEntry](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    workspaceEditor: {
      syncBuffer: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceEditorSyncBuffer](input)),
      closeBuffer: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceEditorCloseBuffer](input)),
      complete: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceEditorComplete](input)),
      definition: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceEditorDefinition](input)),
      references: (input) =>
        transport.request((client) => client[WS_METHODS.workspaceEditorReferences](input)),
    },
    git: {
      status: (input) => transport.request((client) => client[WS_METHODS.gitStatus](input)),
      readWorkingTreeDiff: (input) =>
        transport.request((client) => client[WS_METHODS.gitReadWorkingTreeDiff](input)),
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      listGitHubIssues: (input) =>
        transport.request((client) => client[WS_METHODS.gitListGitHubIssues](input)),
      getGitHubIssueThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetGitHubIssueThread](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;
        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );
        if (result) {
          return result;
        }
        throw new Error("Git action stream completed without a final result.");
      },
    },
    terminal: {
      open: (input: TerminalOpenInput) =>
        transport.request((client) =>
          client[WS_METHODS.terminalOpen](withTerminalId<TerminalOpenInput>(input)),
        ),
      write: (input: TerminalWriteInput) =>
        transport.request((client) =>
          client[WS_METHODS.terminalWrite](withTerminalId<TerminalWriteInput>(input)),
        ),
      resize: (input: TerminalResizeInput) =>
        transport.request((client) =>
          client[WS_METHODS.terminalResize](withTerminalId<TerminalResizeInput>(input)),
        ),
      clear: (input: TerminalClearInput) =>
        transport.request((client) =>
          client[WS_METHODS.terminalClear](withTerminalId<TerminalClearInput>(input)),
        ),
      restart: (input: TerminalRestartInput) =>
        transport.request((client) =>
          client[WS_METHODS.terminalRestart](withTerminalId<TerminalRestartInput>(input)),
        ),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents](streamIdentity),
          listener,
        ),
    },
    orchestration: {
      getSnapshot: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot](input ?? {})),
      getThread: (threadId) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getThread]({ threadId })),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      dispatchCommand: (command) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](command)),
      onDomainEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents](streamIdentity),
          listener,
        ),
    },
  };
}
