import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type NativeApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@ace/contracts";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./rpc/protocol";
import { type WsTransportConnectionState, WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly subscribeConnectionState: (
    listener: (state: WsTransportConnectionState) => void,
  ) => () => void;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly listTree: RpcUnaryMethod<typeof WS_METHODS.projectsListTree>;
    readonly createEntry: RpcUnaryMethod<typeof WS_METHODS.projectsCreateEntry>;
    readonly deleteEntry: RpcUnaryMethod<typeof WS_METHODS.projectsDeleteEntry>;
    readonly readFile: RpcUnaryMethod<typeof WS_METHODS.projectsReadFile>;
    readonly renameEntry: RpcUnaryMethod<typeof WS_METHODS.projectsRenameEntry>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly workspaceEditor: {
    readonly syncBuffer: RpcUnaryMethod<typeof WS_METHODS.workspaceEditorSyncBuffer>;
    readonly closeBuffer: RpcUnaryMethod<typeof WS_METHODS.workspaceEditorCloseBuffer>;
    readonly complete: RpcUnaryMethod<typeof WS_METHODS.workspaceEditorComplete>;
    readonly definition: RpcUnaryMethod<typeof WS_METHODS.workspaceEditorDefinition>;
    readonly references: RpcUnaryMethod<typeof WS_METHODS.workspaceEditorReferences>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<NativeApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<NativeApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<NativeApi["shell"]["openInEditor"]>;
    readonly revealInFileManager: (input: {
      readonly path: Parameters<NativeApi["shell"]["revealInFileManager"]>[0];
    }) => ReturnType<NativeApi["shell"]["revealInFileManager"]>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly status: RpcUnaryMethod<typeof WS_METHODS.gitStatus>;
    readonly listGitHubIssues: RpcUnaryMethod<typeof WS_METHODS.gitListGitHubIssues>;
    readonly getGitHubIssueThread: RpcUnaryMethod<typeof WS_METHODS.gitGetGitHubIssueThread>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly pickFolder: RpcUnaryMethod<typeof WS_METHODS.serverPickFolder>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly getLspToolsStatus: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetLspToolsStatus>;
    readonly installLspTools: RpcUnaryMethod<typeof WS_METHODS.serverInstallLspTools>;
    readonly searchLspMarketplace: RpcUnaryMethod<typeof WS_METHODS.serverSearchLspMarketplace>;
    readonly installLspTool: RpcUnaryMethod<typeof WS_METHODS.serverInstallLspTool>;
    readonly searchOpenCodeModels: RpcUnaryMethod<typeof WS_METHODS.serverSearchOpenCodeModels>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
  };
  readonly orchestration: {
    readonly getSnapshot: (
      input?: Parameters<NativeApi["orchestration"]["getSnapshot"]>[0],
    ) => ReturnType<NativeApi["orchestration"]["getSnapshot"]>;
    readonly getThread: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getThread>;
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly replayEvents: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.replayEvents>;
    readonly onDomainEvent: RpcStreamMethod<typeof WS_METHODS.subscribeOrchestrationDomainEvents>;
  };
}

let sharedWsRpcClient: WsRpcClient | null = null;

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient;
  }
  sharedWsRpcClient = createWsRpcClient();
  return sharedWsRpcClient;
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
}

export async function resetWsRpcClient(): Promise<void> {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
}

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  const streamIdentity = transport.getConnectionIdentity();
  return {
    dispose: () => transport.dispose(),
    subscribeConnectionState: (listener) => transport.onConnectionStateChange(listener),
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents](streamIdentity),
          listener,
        ),
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
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
      revealInFileManager: (input) =>
        transport.request((client) => client[WS_METHODS.shellRevealInFileManager](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      status: (input) => transport.request((client) => client[WS_METHODS.gitStatus](input)),
      listGitHubIssues: (input) =>
        transport.request((client) => client[WS_METHODS.gitListGitHubIssues](input)),
      getGitHubIssueThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetGitHubIssueThread](input)),
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
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      pickFolder: (input) =>
        transport.request((client) => client[WS_METHODS.serverPickFolder](input)),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      getLspToolsStatus: () =>
        transport.request((client) => client[WS_METHODS.serverGetLspToolsStatus]({})),
      installLspTools: (input) =>
        transport.request((client) => client[WS_METHODS.serverInstallLspTools](input)),
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
      subscribeConfig: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig](streamIdentity),
          listener,
        ),
      subscribeLifecycle: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle](streamIdentity),
          listener,
        ),
    },
    orchestration: {
      getSnapshot: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot](input ?? {})),
      getThread: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getThread](input)),
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      replayEvents: (input) =>
        transport
          .request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input))
          .then((events) => [...events]),
      onDomainEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents](streamIdentity),
          listener,
        ),
    },
  };
}
