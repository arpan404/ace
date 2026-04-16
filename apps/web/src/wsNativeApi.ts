import { type ContextMenuItem, type NativeApi } from "@ace/contracts";

import { showContextMenuFallback } from "./contextMenuFallback";
import { requestAppConfirm } from "./lib/appConfirm";
import { runAsyncTask } from "./lib/async";
import {
  readRouteConnectionUrlFromLocation,
  resolveConnectionForInput,
  resolveLocalConnectionUrl,
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
        return requestAppConfirm(message);
      },
    },
    browser: {
      repairStorage: async () => {
        if (!window.desktopBridge) {
          return false;
        }
        return window.desktopBridge.repairBrowserStorage();
      },
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
      searchEntries: (input) => resolveRpcClientForActiveRoute().projects.searchEntries(input),
      listTree: (input) => resolveRpcClientForActiveRoute().projects.listTree(input),
      createEntry: (input) => resolveRpcClientForActiveRoute().projects.createEntry(input),
      deleteEntry: (input) => resolveRpcClientForActiveRoute().projects.deleteEntry(input),
      readFile: (input) => resolveRpcClientForActiveRoute().projects.readFile(input),
      renameEntry: (input) => resolveRpcClientForActiveRoute().projects.renameEntry(input),
      writeFile: (input) => resolveRpcClientForActiveRoute().projects.writeFile(input),
    },
    filesystem: {
      browse: (input) => resolveRpcClientForActiveRoute().filesystem.browse(input),
    },
    workspaceEditor: {
      syncBuffer: (input) => resolveRpcClientForActiveRoute().workspaceEditor.syncBuffer(input),
      closeBuffer: (input) => resolveRpcClientForActiveRoute().workspaceEditor.closeBuffer(input),
      complete: (input) => resolveRpcClientForActiveRoute().workspaceEditor.complete(input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        resolveRpcClientForActiveRoute().shell.openInEditor({ cwd, editor }),
      revealInFileManager: (path) =>
        resolveRpcClientForActiveRoute().shell.revealInFileManager({ path }),
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
      pull: (input) => resolveRpcClientForActiveRoute().git.pull(input),
      status: (input) => resolveRpcClientForActiveRoute().git.status(input),
      listBranches: (input) => resolveRpcClientForActiveRoute().git.listBranches(input),
      listGitHubIssues: (input) => resolveRpcClientForActiveRoute().git.listGitHubIssues(input),
      getGitHubIssueThread: (input) =>
        resolveRpcClientForActiveRoute().git.getGitHubIssueThread(input),
      createWorktree: (input) => resolveRpcClientForActiveRoute().git.createWorktree(input),
      removeWorktree: (input) => resolveRpcClientForActiveRoute().git.removeWorktree(input),
      createBranch: (input) => resolveRpcClientForActiveRoute().git.createBranch(input),
      checkout: (input) => resolveRpcClientForActiveRoute().git.checkout(input),
      init: (input) => resolveRpcClientForActiveRoute().git.init(input),
      resolvePullRequest: (input) => resolveRpcClientForActiveRoute().git.resolvePullRequest(input),
      preparePullRequestThread: (input) =>
        resolveRpcClientForActiveRoute().git.preparePullRequestThread(input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: localRpcClient.server.getConfig,
      refreshProviders: localRpcClient.server.refreshProviders,
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
