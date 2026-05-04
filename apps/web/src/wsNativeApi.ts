import { type ContextMenuItem, type NativeApi } from "@ace/contracts";

import { showConfirmDialogFallback } from "./confirmDialogFallback";
import { showContextMenuFallback } from "./contextMenuFallback";
import { runAsyncTask } from "./lib/async";
import {
  readRouteConnectionUrlFromLocation,
  resolveConnectionForInput,
  resolveLocalConnectionUrl,
  stripRpcRouteConnection,
} from "./lib/connectionRouting";
import { useHostConnectionStore } from "./hostConnectionStore";
import { getRouteRpcClient } from "./lib/remoteWsRouter";
import { resetServerStateForTests } from "./rpc/serverState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;
let disposeHandlerRegistered = false;

export function __resetWsNativeApiForTests() {
  instance = null;
  disposeHandlerRegistered = false;
  __resetWsRpcClientForTests();
  resetServerStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const localRpcClient = getWsRpcClient();
  const resolveRpcClientForInput = (input?: unknown) =>
    getRouteRpcClient(resolveConnectionForInput(input));
  const resolveRpcClientForActiveRoute = () =>
    getRouteRpcClient(readRouteConnectionUrlFromLocation() ?? resolveLocalConnectionUrl());
  if (
    !disposeHandlerRegistered &&
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    const disposeRpcClient = () => {
      runAsyncTask(
        localRpcClient.dispose(),
        "Failed to dispose the WebSocket RPC client during page teardown.",
      );
    };
    window.addEventListener("pagehide", disposeRpcClient, { once: true });
    window.addEventListener("beforeunload", disposeRpcClient, { once: true });
    disposeHandlerRegistered = true;
  }

  const api: NativeApi = {
    dialogs: {
      pickFolder: async (options) => {
        if (window.desktopBridge) {
          return options === undefined
            ? window.desktopBridge.pickFolder()
            : window.desktopBridge.pickFolder(options);
        }
        return localRpcClient.server.pickFolder(options ?? {});
      },
      confirm: async (message) => {
        return showConfirmDialogFallback(message);
      },
    },
    browser: {
      repairStorage: async () => {
        if (!window.desktopBridge) {
          return false;
        }
        return window.desktopBridge.repairBrowserStorage();
      },
      resolveBridgeRequest: (input) =>
        resolveRpcClientForActiveRoute().browserBridge.resolve(input),
      onBridgeRequest: (callback) =>
        resolveRpcClientForActiveRoute().browserBridge.onRequest(callback),
    },
    terminal: {
      open: (input) => resolveRpcClientForInput(input).terminal.open(input as never),
      write: (input) => resolveRpcClientForInput(input).terminal.write(input as never),
      resize: (input) => resolveRpcClientForInput(input).terminal.resize(input as never),
      clear: (input) => resolveRpcClientForInput(input).terminal.clear(input as never),
      restart: (input) => resolveRpcClientForInput(input).terminal.restart(input as never),
      close: (input) => resolveRpcClientForInput(input).terminal.close(input as never),
      onEvent: (callback) => resolveRpcClientForActiveRoute().terminal.onEvent(callback),
    },
    projects: {
      searchEntries: (input) =>
        resolveRpcClientForInput(input).projects.searchEntries(stripRpcRouteConnection(input)),
      listTree: (input) =>
        resolveRpcClientForInput(input).projects.listTree(stripRpcRouteConnection(input)),
      createEntry: (input) =>
        resolveRpcClientForInput(input).projects.createEntry(stripRpcRouteConnection(input)),
      deleteEntry: (input) =>
        resolveRpcClientForInput(input).projects.deleteEntry(stripRpcRouteConnection(input)),
      readFile: (input) =>
        resolveRpcClientForInput(input).projects.readFile(stripRpcRouteConnection(input)),
      renameEntry: (input) =>
        resolveRpcClientForInput(input).projects.renameEntry(stripRpcRouteConnection(input)),
      writeFile: (input) =>
        resolveRpcClientForInput(input).projects.writeFile(stripRpcRouteConnection(input)),
    },
    filesystem: {
      browse: (input) =>
        resolveRpcClientForInput(input).filesystem.browse(stripRpcRouteConnection(input)),
    },
    workspaceEditor: {
      syncBuffer: (input) =>
        resolveRpcClientForInput(input).workspaceEditor.syncBuffer(stripRpcRouteConnection(input)),
      closeBuffer: (input) =>
        resolveRpcClientForInput(input).workspaceEditor.closeBuffer(stripRpcRouteConnection(input)),
      complete: (input) =>
        resolveRpcClientForInput(input).workspaceEditor.complete(stripRpcRouteConnection(input)),
      definition: (input) =>
        resolveRpcClientForInput(input).workspaceEditor.definition(stripRpcRouteConnection(input)),
      references: (input) =>
        resolveRpcClientForInput(input).workspaceEditor.references(stripRpcRouteConnection(input)),
    },
    shell: {
      openInEditor: (cwd, editor, options) =>
        resolveRpcClientForInput(options).shell.openInEditor({ cwd, editor }),
      revealInFileManager: (path, options) =>
        resolveRpcClientForInput(options).shell.revealInFileManager({ path }),
      pathExists: (path, options) => resolveRpcClientForInput(options).shell.pathExists({ path }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => resolveRpcClientForInput(input).git.pull(stripRpcRouteConnection(input)),
      status: (input) => resolveRpcClientForInput(input).git.status(stripRpcRouteConnection(input)),
      readWorkingTreeDiff: (input) =>
        resolveRpcClientForInput(input).git.readWorkingTreeDiff(stripRpcRouteConnection(input)),
      listBranches: (input) =>
        resolveRpcClientForInput(input).git.listBranches(stripRpcRouteConnection(input)),
      listGitHubIssues: (input) =>
        resolveRpcClientForInput(input).git.listGitHubIssues(stripRpcRouteConnection(input)),
      getGitHubIssueThread: (input) =>
        resolveRpcClientForInput(input).git.getGitHubIssueThread(stripRpcRouteConnection(input)),
      createWorktree: (input) =>
        resolveRpcClientForInput(input).git.createWorktree(stripRpcRouteConnection(input)),
      removeWorktree: (input) =>
        resolveRpcClientForInput(input).git.removeWorktree(stripRpcRouteConnection(input)),
      createBranch: (input) =>
        resolveRpcClientForInput(input).git.createBranch(stripRpcRouteConnection(input)),
      checkout: (input) =>
        resolveRpcClientForInput(input).git.checkout(stripRpcRouteConnection(input)),
      init: (input) => resolveRpcClientForInput(input).git.init(stripRpcRouteConnection(input)),
      resolvePullRequest: (input) =>
        resolveRpcClientForInput(input).git.resolvePullRequest(stripRpcRouteConnection(input)),
      preparePullRequestThread: (input) =>
        resolveRpcClientForInput(input).git.preparePullRequestThread(
          stripRpcRouteConnection(input),
        ),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: localRpcClient.server.getConfig,
      refreshProviders: localRpcClient.server.refreshProviders,
      upgradeProviderCli: localRpcClient.server.upgradeProviderCli,
      getLspToolsStatus: localRpcClient.server.getLspToolsStatus,
      installLspTools: (input) => localRpcClient.server.installLspTools(input ?? {}),
      searchLspMarketplace: localRpcClient.server.searchLspMarketplace,
      installLspTool: localRpcClient.server.installLspTool,
      searchOpenCodeModels: localRpcClient.server.searchOpenCodeModels,
      upsertKeybinding: localRpcClient.server.upsertKeybinding,
      getSettings: localRpcClient.server.getSettings,
      updateSettings: localRpcClient.server.updateSettings,
    },
    orchestration: {
      getSnapshot: (input) => resolveRpcClientForInput(input).orchestration.getSnapshot(input),
      getThread: (input) => resolveRpcClientForInput(input).orchestration.getThread(input),
      dispatchCommand: async (input) => {
        const connectionUrl = resolveConnectionForInput(input);
        const response =
          await getRouteRpcClient(connectionUrl).orchestration.dispatchCommand(input);
        if (input.type === "thread.create") {
          useHostConnectionStore.getState().upsertThreadOwnership(connectionUrl, input.threadId);
        }
        return response;
      },
      getTurnDiff: (input) => resolveRpcClientForInput(input).orchestration.getTurnDiff(input),
      getFullThreadDiff: (input) =>
        resolveRpcClientForInput(input).orchestration.getFullThreadDiff(input),
      replayEvents: (fromSequenceExclusive) =>
        resolveRpcClientForActiveRoute()
          .orchestration.replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) =>
        resolveRpcClientForActiveRoute().orchestration.onDomainEvent(callback),
    },
  };

  instance = { api };
  return api;
}
