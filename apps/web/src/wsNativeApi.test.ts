import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EventId,
  ProjectId,
  type OrchestrationEvent,
  type ServerConfig,
  type ServerProvider,
  type TerminalEvent,
  ThreadId,
} from "@ace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@ace/contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
const orchestrationEventListeners = new Set<(event: OrchestrationEvent) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  subscribeConnectionState: vi.fn(() => () => undefined),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  projects: {
    createEntry: vi.fn(),
    deleteEntry: vi.fn(),
    listTree: vi.fn(),
    readFile: vi.fn(),
    renameEntry: vi.fn(),
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  filesystem: {
    browse: vi.fn(),
  },
  workspaceEditor: {
    syncBuffer: vi.fn(),
    closeBuffer: vi.fn(),
    complete: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
    revealInFileManager: vi.fn(),
  },
  git: {
    pull: vi.fn(),
    status: vi.fn(),
    readWorkingTreeDiff: vi.fn(),
    runStackedAction: vi.fn(),
    listBranches: vi.fn(),
    listGitHubIssues: vi.fn(),
    getGitHubIssueThread: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    init: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    pickFolder: vi.fn(),
    refreshProviders: vi.fn(),
    getLspToolsStatus: vi.fn(),
    installLspTools: vi.fn(),
    searchLspMarketplace: vi.fn(),
    installLspTool: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
  },
  orchestration: {
    getSnapshot: vi.fn(),
    getThread: vi.fn(),
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    replayEvents: vi.fn(),
    onDomainEvent: vi.fn((listener: (event: OrchestrationEvent) => void) =>
      registerListener(orchestrationEventListeners, listener),
    ),
  },
};

vi.mock("./wsRpcClient", () => {
  return {
    getWsRpcClient: () => rpcClientMock,
    __resetWsRpcClientForTests: vi.fn(),
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function ensureLocationForTestWindow(
  target: Window & typeof globalThis & { desktopBridge?: unknown },
): void {
  const location = (target as { location?: Partial<Location> }).location;
  if (!location) {
    (target as { location: Location }).location = {
      search: "",
      origin: "http://localhost:3773",
      protocol: "http:",
    } as Location;
    return;
  }
  const mutableLocation = location as {
    search?: string;
    origin?: string;
    protocol?: string;
  };
  if (typeof mutableLocation.search !== "string") {
    mutableLocation.search = "";
  }
  if (typeof mutableLocation.origin !== "string" || mutableLocation.origin.length === 0) {
    mutableLocation.origin = "http://localhost:3773";
  }
  if (typeof mutableLocation.protocol !== "string" || mutableLocation.protocol.length === 0) {
    mutableLocation.protocol = "http:";
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {
      location: {
        search: "",
        origin: "http://localhost:3773",
        protocol: "http:",
      } as Location,
    } as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  ensureLocationForTestWindow(testGlobal.window);
  return testGlobal.window;
}

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    pickFolder: async () => null,
    confirm: async () => true,
    repairBrowserStorage: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    showNotification: async () => true,
    closeNotification: async () => true,
    onNotificationClick: () => () => undefined,
    onNotificationReply: () => () => undefined,
    onMenuAction: () => () => undefined,
    getCliInstallState: async () => {
      throw new Error("getCliInstallState not implemented in test");
    },
    installCli: async () => {
      throw new Error("installCli not implemented in test");
    },
    onCliInstallState: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
  },
];

const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  settings: DEFAULT_SERVER_SETTINGS,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  terminalEventListeners.clear();
  orchestrationEventListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("uses the desktop bridge folder picker when available", async () => {
    const desktopPickFolder = vi.fn().mockResolvedValue("/desktop/project");
    getWindowForTest().desktopBridge = makeDesktopBridge({
      pickFolder: desktopPickFolder,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.dialogs.pickFolder()).resolves.toBe("/desktop/project");
    expect(desktopPickFolder).toHaveBeenCalledWith();
    expect(rpcClientMock.server.pickFolder).not.toHaveBeenCalled();
  });

  it("falls back to the websocket server folder picker in the browser build", async () => {
    rpcClientMock.server.pickFolder.mockResolvedValue("/server/project");
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.dialogs.pickFolder()).resolves.toBe("/server/project");
    expect(rpcClientMock.server.pickFolder).toHaveBeenCalledWith({});
  });

  it("forwards pickFolder options to the desktop runtime", async () => {
    const desktopPickFolder = vi.fn().mockResolvedValue("/desktop/project");
    getWindowForTest().desktopBridge = makeDesktopBridge({
      pickFolder: desktopPickFolder,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");
    const desktopApi = createWsNativeApi();

    await expect(
      desktopApi.dialogs.pickFolder({ initialPath: "/tmp/desktop-start" }),
    ).resolves.toBe("/desktop/project");
    expect(desktopPickFolder).toHaveBeenCalledWith({ initialPath: "/tmp/desktop-start" });
  });

  it("forwards pickFolder options to the websocket runtime", async () => {
    rpcClientMock.server.pickFolder.mockResolvedValue("/server/project");
    const { createWsNativeApi } = await import("./wsNativeApi");
    const browserApi = createWsNativeApi();

    await expect(
      browserApi.dialogs.pickFolder({ initialPath: "/tmp/browser-start" }),
    ).resolves.toBe("/server/project");
    expect(rpcClientMock.server.pickFolder).toHaveBeenCalledWith({
      initialPath: "/tmp/browser-start",
    });
  });

  it("forwards filesystem browse requests to the RPC client", async () => {
    rpcClientMock.filesystem.browse.mockResolvedValue({
      parentPath: "/tmp",
      entries: [{ name: "src", fullPath: "/tmp/src" }],
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.filesystem.browse({ partialPath: "/tmp/s" })).resolves.toEqual({
      parentPath: "/tmp",
      entries: [{ name: "src", fullPath: "/tmp/src" }],
    });
    expect(rpcClientMock.filesystem.browse).toHaveBeenCalledWith({ partialPath: "/tmp/s" });
  });

  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards github issue list requests directly to the git RPC", async () => {
    rpcClientMock.git.listGitHubIssues.mockResolvedValue({
      issues: [
        {
          number: 42,
          title: "Fix timeline empty state",
          state: "open",
          url: "https://github.com/acme/repo/issues/42",
          body: "Details",
          labels: [{ name: "bug" }],
          assignees: [{ login: "octocat" }],
          author: { login: "hubot" },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.git.listGitHubIssues({ cwd: "/tmp/workspace", limit: 20 })).resolves.toEqual({
      issues: [
        {
          number: 42,
          title: "Fix timeline empty state",
          state: "open",
          url: "https://github.com/acme/repo/issues/42",
          body: "Details",
          labels: [{ name: "bug" }],
          assignees: [{ login: "octocat" }],
          author: { login: "hubot" },
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    });
    expect(rpcClientMock.git.listGitHubIssues).toHaveBeenCalledWith({
      cwd: "/tmp/workspace",
      limit: 20,
    });
  });

  it("forwards github issue thread requests directly to the git RPC", async () => {
    rpcClientMock.git.getGitHubIssueThread.mockResolvedValue({
      issue: {
        number: 42,
        title: "Fix timeline empty state",
        state: "open",
        url: "https://github.com/acme/repo/issues/42",
        body: "Details",
        labels: [{ name: "bug" }],
        assignees: [{ login: "octocat" }],
        author: { login: "hubot" },
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:10:00.000Z",
        comments: [
          {
            author: { login: "maintainer" },
            body: "I can reproduce this on macOS.",
            createdAt: "2026-04-08T00:05:00.000Z",
            updatedAt: "2026-04-08T00:06:00.000Z",
            url: "https://github.com/acme/repo/issues/42#issuecomment-1",
          },
        ],
      },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(
      api.git.getGitHubIssueThread({ cwd: "/tmp/workspace", issueNumber: 42 }),
    ).resolves.toEqual({
      issue: {
        number: 42,
        title: "Fix timeline empty state",
        state: "open",
        url: "https://github.com/acme/repo/issues/42",
        body: "Details",
        labels: [{ name: "bug" }],
        assignees: [{ login: "octocat" }],
        author: { login: "hubot" },
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:10:00.000Z",
        comments: [
          {
            author: { login: "maintainer" },
            body: "I can reproduce this on macOS.",
            createdAt: "2026-04-08T00:05:00.000Z",
            updatedAt: "2026-04-08T00:06:00.000Z",
            url: "https://github.com/acme/repo/issues/42#issuecomment-1",
          },
        ],
      },
    });
    expect(rpcClientMock.git.getGitHubIssueThread).toHaveBeenCalledWith({
      cwd: "/tmp/workspace",
      issueNumber: 42,
    });
  });

  it("forwards terminal and orchestration stream events", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitEvent(terminalEventListeners, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitEvent(orchestrationEventListeners, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
  });

  it("defaults orchestration snapshot requests to an empty rpc payload", async () => {
    rpcClientMock.orchestration.getSnapshot.mockResolvedValue({
      snapshotSequence: 1,
      updatedAt: "2026-02-24T00:00:00.000Z",
      projects: [],
      threads: [],
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getSnapshot();

    expect(rpcClientMock.orchestration.getSnapshot).toHaveBeenCalledWith(undefined);
  });

  it("forwards snapshot hydration input to the orchestration rpc", async () => {
    rpcClientMock.orchestration.getSnapshot.mockResolvedValue({
      snapshotSequence: 1,
      updatedAt: "2026-02-24T00:00:00.000Z",
      projects: [],
      threads: [],
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getSnapshot({
      hydrateThreadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(rpcClientMock.orchestration.getSnapshot).toHaveBeenCalledWith({
      hydrateThreadId: "thread-1",
    });
  });

  it("forwards thread hydration requests to the orchestration rpc", async () => {
    rpcClientMock.orchestration.getThread.mockResolvedValue({
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-02-24T00:00:00.000Z",
      updatedAt: "2026-02-24T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      latestProposedPlanSummary: null,
      queuedComposerMessages: [],
      queuedSteerRequest: null,
      activities: [],
      checkpoints: [],
      session: null,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getThread({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(rpcClientMock.orchestration.getThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards workspace entry rename requests to the project RPC", async () => {
    rpcClientMock.projects.renameEntry.mockResolvedValue({
      previousRelativePath: "plan.md",
      relativePath: "docs/plan.md",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.renameEntry({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      nextRelativePath: "docs/plan.md",
    });

    expect(rpcClientMock.projects.renameEntry).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      nextRelativePath: "docs/plan.md",
    });
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
    rpcClientMock.orchestration.getFullThreadDiff.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(rpcClientMock.orchestration.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards LSP tool status requests directly to the RPC client", async () => {
    const status = {
      installDir: "/tmp/ace/userdata/lsp-tools",
      tools: [
        {
          id: "typescript-language-server",
          label: "TypeScript / JavaScript",
          description: "Core IntelliSense for TypeScript and JavaScript.",
          source: "builtin",
          category: "core",
          installer: "npm",
          command: "typescript-language-server",
          args: ["--stdio"],
          packageName: "typescript-language-server",
          installPackages: ["typescript@6.0.3", "typescript-language-server@5.1.3"],
          tags: ["typescript", "javascript"],
          languageIds: ["typescript", "javascript"],
          fileExtensions: [".ts", ".js"],
          fileNames: [],
          builtin: true,
          installed: true,
          version: "5.1.3",
          binaryPath: "/tmp/ace/userdata/lsp-tools/node_modules/.bin/typescript-language-server",
        },
      ],
    } as const;
    rpcClientMock.server.getLspToolsStatus.mockResolvedValue(status);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getLspToolsStatus()).resolves.toEqual(status);
    expect(rpcClientMock.server.getLspToolsStatus).toHaveBeenCalledWith();
  });

  it("forwards LSP install requests directly to the RPC client", async () => {
    const status = {
      installDir: "/tmp/ace/userdata/lsp-tools",
      tools: [],
    } as const;
    rpcClientMock.server.installLspTools.mockResolvedValue(status);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.installLspTools()).resolves.toEqual(status);
    expect(rpcClientMock.server.installLspTools).toHaveBeenCalledWith({});

    await expect(api.server.installLspTools({ reinstall: true })).resolves.toEqual(status);
    expect(rpcClientMock.server.installLspTools).toHaveBeenLastCalledWith({ reinstall: true });
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("always uses the web context menu fallback even when desktop bridge exists", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    showContextMenuFallbackMock.mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, undefined);
    expect(showContextMenu).not.toHaveBeenCalled();
  });

  it("forwards browser storage repair requests to the desktop bridge", async () => {
    const repairBrowserStorage = vi.fn().mockResolvedValue(true);
    getWindowForTest().desktopBridge = makeDesktopBridge({ repairBrowserStorage });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();

    await expect(api.browser.repairStorage()).resolves.toBe(true);
    expect(repairBrowserStorage).toHaveBeenCalledWith();
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });
});
