import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectListTreeInput,
  ProjectListTreeResult,
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  WorkspaceEditorCloseBufferInput,
  WorkspaceEditorCloseBufferResult,
  WorkspaceEditorSyncBufferInput,
  WorkspaceEditorSyncBufferResult,
} from "./workspaceEditor";
import type {
  ServerConfig,
  ServerSearchOpenCodeModelsInput,
  ServerSearchOpenCodeModelsResult,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetSnapshotInput,
  OrchestrationGetThreadInput,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "./orchestration";
import { EditorId } from "./editor";
import { ServerSettings, ServerSettingsPatch } from "./settings";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type BrowserShortcutAction =
  | "back"
  | "close-tab"
  | "devtools"
  | "duplicate-tab"
  | "focus-address-bar"
  | "forward"
  | "move-tab-left"
  | "move-tab-right"
  | "new-tab"
  | "next-tab"
  | "previous-tab"
  | "reload"
  | "select-tab-1"
  | "select-tab-2"
  | "select-tab-3"
  | "select-tab-4"
  | "select-tab-5"
  | "select-tab-6"
  | "select-tab-7"
  | "select-tab-8"
  | "select-tab-9";

export const DESKTOP_MENU_ACTIONS = [
  "new-thread",
  "new-local-thread",
  "toggle-plan-mode",
  "toggle-terminal",
  "toggle-browser",
  "toggle-diff",
  "open-settings",
  "open-settings-chat",
  "open-settings-editor",
  "open-settings-browser",
  "open-settings-models",
  "open-settings-providers",
  "open-settings-advanced",
  "open-settings-about",
  "open-settings-archived",
] as const;

export const DESKTOP_BOOTSTRAP_WS_URL_QUERY_PARAM = "aceWsUrl";
export const DESKTOP_BOOTSTRAP_DEV_BUILD_QUERY_PARAM = "aceDevBuild";

export type DesktopMenuAction = (typeof DESKTOP_MENU_ACTIONS)[number];

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export type DesktopCliInstallStatus =
  | "unsupported"
  | "checking"
  | "missing"
  | "installing"
  | "ready"
  | "error";

export interface DesktopCliInstallState {
  status: DesktopCliInstallStatus;
  binDir: string | null;
  commandPath: string | null;
  pathTargets: ReadonlyArray<string>;
  checkedAt: string | null;
  restartRequired: boolean;
  message: string | null;
}

export interface DesktopCliInstallActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopCliInstallState;
}

export interface DesktopNotificationInput {
  id: string;
  title: string;
  body: string;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getIsDevelopmentBuild?: () => boolean;
  getWindowShownAt?: () => number | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  repairBrowserStorage: () => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  showNotification: (input: DesktopNotificationInput) => Promise<boolean>;
  closeNotification: (id: string) => Promise<boolean>;
  onNotificationClick: (listener: (id: string) => void) => () => void;
  onMenuAction: (listener: (action: DesktopMenuAction) => void) => () => void;
  getCliInstallState: () => Promise<DesktopCliInstallState>;
  installCli: () => Promise<DesktopCliInstallActionResult>;
  onCliInstallState: (listener: (state: DesktopCliInstallState) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  onBrowserOpenUrl?: (listener: (url: string) => void) => () => void;
  onBrowserContextMenuShown?: (listener: () => void) => () => void;
  onBrowserShortcutAction?: (listener: (action: BrowserShortcutAction) => void) => () => void;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  browser: {
    repairStorage: () => Promise<boolean>;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    listTree: (input: ProjectListTreeInput) => Promise<ProjectListTreeResult>;
    createEntry: (input: ProjectCreateEntryInput) => Promise<ProjectCreateEntryResult>;
    deleteEntry: (input: ProjectDeleteEntryInput) => Promise<ProjectDeleteEntryResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    renameEntry: (input: ProjectRenameEntryInput) => Promise<ProjectRenameEntryResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  workspaceEditor: {
    syncBuffer: (input: WorkspaceEditorSyncBufferInput) => Promise<WorkspaceEditorSyncBufferResult>;
    closeBuffer: (
      input: WorkspaceEditorCloseBufferInput,
    ) => Promise<WorkspaceEditorCloseBufferResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    searchOpenCodeModels: (
      input: ServerSearchOpenCodeModelsInput,
    ) => Promise<ServerSearchOpenCodeModelsResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  };
  orchestration: {
    getSnapshot: (input?: OrchestrationGetSnapshotInput) => Promise<OrchestrationReadModel>;
    getThread: (input: OrchestrationGetThreadInput) => Promise<OrchestrationThread>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
