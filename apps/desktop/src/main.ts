import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification as ElectronNotification,
  protocol,
  session,
  systemPreferences,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import type {
  BrowserShortcutAction,
  DesktopCliInstallActionResult,
  DesktopCliInstallState,
  DesktopMenuAction,
  DesktopNotificationInput,
  DesktopNotificationPermission,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@ace/contracts";
import {
  ensureAceCliInstalledWithProgress,
  inspectAceCliInstall,
  type AceCliInstallOptions,
  type AceCliInstallResult,
} from "@ace/shared/cliInstall";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@ace/contracts";
import { NetService } from "@ace/shared/Net";
import { RotatingFileSink } from "@ace/shared/logging";
import {
  createDesktopCliInstallStateFromInspect,
  createDesktopCliInstallStateFromResult,
  createPendingDesktopCliInstallState,
  createUnsupportedDesktopCliInstallState,
} from "./desktopCliInstall";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { resolveDesktopBaseDir, resolveDesktopUserDataPath } from "./stateMigration";
import { syncShellEnvironment } from "./syncShellEnvironment";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import { appendDesktopBootstrapWsUrl } from "./rendererBootstrapUrl";
import { buildWebContentsContextMenuTemplate } from "./webContentsContextMenu";
import { buildApplicationMenuTemplate } from "./applicationMenu";
import {
  startDesktopBackgroundNotificationService,
  type DesktopBackgroundNotificationService,
} from "./backgroundNotificationService";

syncShellEnvironment();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const REPAIR_BROWSER_STORAGE_CHANNEL = "desktop:repair-browser-storage";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const SHOW_NOTIFICATION_CHANNEL = "desktop:show-notification";
const CLOSE_NOTIFICATION_CHANNEL = "desktop:close-notification";
const NOTIFICATION_CLICK_CHANNEL = "desktop:notification-click";
const NOTIFICATION_REPLY_CHANNEL = "desktop:notification-reply";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const CLI_STATE_CHANNEL = "desktop:cli-state";
const CLI_GET_STATE_CHANNEL = "desktop:cli-get-state";
const CLI_INSTALL_CHANNEL = "desktop:cli-install";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const GET_IS_DEVELOPMENT_BUILD_CHANNEL = "desktop:get-is-development-build";
const GET_WINDOW_SHOWN_AT_CHANNEL = "desktop:get-window-shown-at";
const GET_TITLEBAR_LEFT_INSET_CHANNEL = "desktop:get-titlebar-left-inset";
const GET_NOTIFICATION_PERMISSION_CHANNEL = "desktop:get-notification-permission";
const REQUEST_NOTIFICATION_PERMISSION_CHANNEL = "desktop:request-notification-permission";
const BROWSER_OPEN_URL_CHANNEL = "desktop:browser-open-url";
const BROWSER_CONTEXT_MENU_SHOWN_CHANNEL = "desktop:browser-context-menu-shown";
const BROWSER_SHORTCUT_ACTION_CHANNEL = "desktop:browser-shortcut-action";
const ORCHESTRATION_EVENT_CHANNEL = "desktop:orchestration-event";
const SERVER_CONFIG_EVENT_CHANNEL = "desktop:server-config-event";
const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 };
const MAC_TITLEBAR_LEFT_INSET_PX = 90;
const isSourceCheckoutRun = process.env.ACE_LOCAL_DESKTOP_RUN === "1";
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL) || isSourceCheckoutRun;
const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
const useDevRenderer = typeof devServerUrl === "string" && devServerUrl.length > 0;
const BASE_DIR = process.env.ACE_HOME?.trim() || resolveDesktopBaseDir({ isDevelopment });
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_SCHEME = "ace";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopmentBuild = isDevelopment || isSourceCheckoutRun || !app.isPackaged;
const APP_DISPLAY_NAME = "ace";
const APP_USER_MODEL_ID = "com.ace.ace";
const LINUX_DESKTOP_ENTRY_NAME = isDevelopment ? "ace-dev.desktop" : "ace.desktop";
const LINUX_WM_CLASS = isDevelopment ? "ace-dev" : "ace";
const USER_DATA_DIR_NAME = isDevelopment ? "ace-dev" : "ace";
const useDaemonBackend = !isDevelopmentBuild;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const DAEMON_LOGIN_ITEM_ARG = "--daemon-login-item";
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAIN_WINDOW_SHOW_FALLBACK_DELAY_MS = 4_000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const IN_APP_BROWSER_PARTITION = "persist:ace-browser";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];
type LinuxDesktopNamedApp = Electron.App & {
  setDesktopName?: (desktopName: string) => void;
};
interface DaemonStartOutput {
  readonly status: "started" | "already-running";
  readonly daemon: {
    readonly pid: number;
    readonly port: number;
    readonly authToken: string;
    readonly wsUrl: string;
  };
}
interface DaemonStatusOutput {
  readonly status: "running" | "stopped" | "stale";
  readonly state: {
    readonly pid: number;
  } | null;
}
interface DaemonStopOutput {
  readonly status: "already-stopped" | "cleared-stale-state" | "stopped";
  readonly pid?: number;
}

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let backendManagedByDaemon = false;
let mainWindowShownAtMs: number | null = null;
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let desktopBackgroundNotificationService: DesktopBackgroundNotificationService | null = null;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const activeDesktopNotifications = new Map<string, Electron.Notification>();
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

function desktopCliMetadataOptions() {
  const shell = process.env.SHELL;
  return {
    baseDir: BASE_DIR,
    platform: process.platform,
    env: process.env,
    homeDir: OS.homedir(),
    ...(shell !== undefined ? { shell } : {}),
  };
}

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ACE_PORT;
  delete env.ACE_AUTH_TOKEN;
  delete env.ACE_MODE;
  delete env.ACE_NO_BROWSER;
  delete env.ACE_HOST;
  delete env.ACE_DESKTOP_WS_URL;
  return env;
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function getSafeDesktopNotificationInput(rawInput: unknown): DesktopNotificationInput | null {
  if (typeof rawInput !== "object" || rawInput === null) {
    return null;
  }

  const input = rawInput as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const deepLink = typeof input.deepLink === "string" ? input.deepLink.trim() : "";
  const rawReply =
    typeof input.reply === "object" && input.reply !== null
      ? (input.reply as Record<string, unknown>)
      : null;
  const replyPlaceholder =
    rawReply && typeof rawReply.placeholder === "string" ? rawReply.placeholder.trim() : "";
  if (id.length === 0 || title.length === 0 || body.length === 0) {
    return null;
  }

  return {
    id,
    title,
    body,
    ...(deepLink.length > 0 ? { deepLink } : {}),
    ...(rawReply
      ? {
          reply: replyPlaceholder.length > 0 ? { placeholder: replyPlaceholder } : {},
        }
      : {}),
  };
}

function getOrCreatePrimaryWindow(): BrowserWindow {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }
  return targetWindow;
}

function focusPrimaryWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
}

function withReadyPrimaryWindow(effect: (window: BrowserWindow) => void): void {
  const targetWindow = getOrCreatePrimaryWindow();
  focusPrimaryWindow(targetWindow);
  const run = () => {
    if (targetWindow.isDestroyed()) {
      return;
    }
    effect(targetWindow);
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", run);
    return;
  }

  run();
}

function isDesktopWindowFocusedForNotifications(): boolean {
  const targetWindow =
    mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false;
  }
  if (!targetWindow.isVisible() || targetWindow.isMinimized()) {
    return false;
  }
  return targetWindow.isFocused();
}

function stopDesktopBackgroundNotifications(): void {
  const service = desktopBackgroundNotificationService;
  desktopBackgroundNotificationService = null;
  if (!service) {
    return;
  }
  void service.stop();
}

function startDesktopBackgroundNotifications(): void {
  stopDesktopBackgroundNotifications();
  desktopBackgroundNotificationService = startDesktopBackgroundNotificationService({
    onOrchestrationEvent: (_event) => {
      // Will be called via IPC from web app
    },
    onServerConfigEvent: (_event) => {
      // Will be called via IPC from web app
    },
    isAppFocused: isDesktopWindowFocusedForNotifications,
    showNotification: showDesktopNotification,
    closeNotification: closeDesktopNotification,
    log: (message) => writeDesktopLogHeader(`notification-service ${message}`),
  });
}

function closeDesktopNotification(id: string): boolean {
  const existingNotification = activeDesktopNotifications.get(id);
  if (!existingNotification) {
    return false;
  }

  activeDesktopNotifications.delete(id);
  existingNotification.close();
  return true;
}

function showDesktopNotification(input: DesktopNotificationInput): boolean {
  const permission = getDesktopNotificationPermission();
  if (permission === "denied" || permission === "unsupported") {
    return false;
  }
  if (!ElectronNotification.isSupported()) {
    return false;
  }

  closeDesktopNotification(input.id);

  try {
    const notification = new ElectronNotification({
      title: input.title,
      body: input.body,
      ...(process.platform === "darwin" && input.reply
        ? {
            hasReply: true,
            ...(input.reply.placeholder ? { replyPlaceholder: input.reply.placeholder } : {}),
          }
        : {}),
    });

    notification.on("click", () => {
      closeDesktopNotification(input.id);
      withReadyPrimaryWindow((window) => {
        window.webContents.send(NOTIFICATION_CLICK_CHANNEL, {
          id: input.id,
          ...(input.deepLink ? { deepLink: input.deepLink } : {}),
        });
      });
    });
    notification.on("reply", (_event, response) => {
      closeDesktopNotification(input.id);
      withReadyPrimaryWindow((window) => {
        window.webContents.send(NOTIFICATION_REPLY_CHANNEL, {
          id: input.id,
          response,
          ...(input.deepLink ? { deepLink: input.deepLink } : {}),
        });
      });
    });
    notification.on("close", () => {
      if (activeDesktopNotifications.get(input.id) === notification) {
        activeDesktopNotifications.delete(input.id);
      }
    });

    activeDesktopNotifications.set(input.id, notification);
    notification.show();
    return true;
  } catch {
    activeDesktopNotifications.delete(input.id);
    return false;
  }
}

function mapDesktopNotificationPermissionState(
  rawState: string,
): DesktopNotificationPermission | null {
  const normalized = rawState.trim().toLowerCase();
  if (
    normalized === "granted" ||
    normalized === "authorized" ||
    normalized === "ephemeral" ||
    normalized === "enabled"
  ) {
    return "granted";
  }
  if (normalized === "denied" || normalized === "disabled") {
    return "denied";
  }
  if (
    normalized === "default" ||
    normalized === "not-determined" ||
    normalized === "provisional" ||
    normalized === "unknown"
  ) {
    return "default";
  }
  if (normalized === "notsupported" || normalized === "not-supported") {
    return "unsupported";
  }
  return null;
}

function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!ElectronNotification.isSupported()) {
    return "unsupported";
  }

  if (process.platform === "darwin" || process.platform === "win32") {
    const notificationStateProvider = systemPreferences as unknown as {
      getNotificationState?: (...args: string[]) => string;
    };
    const readNotificationState = notificationStateProvider.getNotificationState;
    if (typeof readNotificationState === "function") {
      const resolveState = (rawState: string | null): DesktopNotificationPermission | null =>
        rawState ? mapDesktopNotificationPermissionState(rawState) : null;
      try {
        const globalState = resolveState(readNotificationState());
        if (globalState) {
          return globalState;
        }
      } catch {
        // Fall through and try app-scoped state.
      }
      try {
        const appScopedState = resolveState(readNotificationState(APP_USER_MODEL_ID));
        if (appScopedState) {
          return appScopedState;
        }
      } catch {
        // Fall through to platform defaults when OS-level state cannot be read.
      }
    }

    // On macOS, treat unknown state conservatively so the UI can still prompt/check.
    if (process.platform === "darwin") {
      return "default";
    }
  }

  return "granted";
}

async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  const initialPermission = getDesktopNotificationPermission();
  if (initialPermission !== "default") {
    return initialPermission;
  }

  const probeNotificationId = `ace-notification-permission-request:${Date.now().toString(36)}`;
  showDesktopNotification({
    id: probeNotificationId,
    title: "ace notifications",
    body: "Enable notifications to get alerts when agent work completes or needs input.",
  });

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 300);
  });
  closeDesktopNotification(probeNotificationId);
  return getDesktopNotificationPermission();
}

function resolveBrowserShortcutAction(input: Electron.Input): BrowserShortcutAction | null {
  if (input.type !== "keyDown") {
    return null;
  }

  const usesMod = process.platform === "darwin" ? input.meta === true : input.control === true;
  if (!usesMod) {
    return null;
  }

  const key = input.key.toLowerCase();
  if (input.alt === true) {
    if (key === "[") return "move-tab-left";
    if (key === "]") return "move-tab-right";
    return null;
  }

  if (input.shift === true) {
    if (key === "d") return "duplicate-tab";
    if (key === "i") return "devtools";
    if (key === "[") return "previous-tab";
    if (key === "]") return "next-tab";
    return null;
  }

  if (key === "[") return "back";
  if (key === "]") return "forward";
  if (key === "l") return "focus-address-bar";
  if (key === "n") return "new-tab";
  if (key === "r") return "reload";
  if (key === "w") return "close-tab";
  if (key >= "1" && key <= "9") {
    return `select-tab-${key}` as BrowserShortcutAction;
  }

  return null;
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    if (!backendLogSink) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendLogSink.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}

initializePackagedLogging();

if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", LINUX_WM_CLASS);
}

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updateInstallInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let cliInstallInFlight = false;
let cliInstallState: DesktopCliInstallState = app.isPackaged
  ? createPendingDesktopCliInstallState({
      ...desktopCliMetadataOptions(),
      status: "checking",
      message: "Checking the ace CLI installation.",
    })
  : createUnsupportedDesktopCliInstallState({
      ...desktopCliMetadataOptions(),
      message: "CLI install is only available in packaged desktop builds.",
    });

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    return normalizeCommitHash(parseJsonObject(raw)?.aceCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.ACE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/bin.mjs");
}

function resolveTitlebarLeftInset(window: BrowserWindow | null | undefined): number {
  if (process.platform !== "darwin") {
    return 0;
  }

  if (!window) {
    return MAC_TITLEBAR_LEFT_INSET_PX;
  }

  if (window.isFullScreen() || window.isSimpleFullScreen() === true) {
    return 0;
  }

  return MAC_TITLEBAR_LEFT_INSET_PX;
}

function getDesktopCliUnavailableMessage(): string {
  if (!app.isPackaged) {
    return "CLI install is only available in packaged desktop builds.";
  }

  if (!FS.existsSync(process.execPath)) {
    return "The packaged app launcher could not be found.";
  }

  if (!FS.existsSync(resolveBackendEntry())) {
    return "Bundled CLI files are missing from this desktop build.";
  }

  return "CLI installation is unavailable in this build.";
}

function createUnsupportedCliInstallState(checkedAt: string | null = null): DesktopCliInstallState {
  return createUnsupportedDesktopCliInstallState({
    ...desktopCliMetadataOptions(),
    checkedAt,
    message: getDesktopCliUnavailableMessage(),
  });
}

function resolveDesktopCliInstallOptions(): AceCliInstallOptions | null {
  if (!app.isPackaged) {
    return null;
  }

  const launchCommand = process.execPath;
  const cliEntry = resolveBackendEntry();
  if (!FS.existsSync(launchCommand) || !FS.existsSync(cliEntry)) {
    return null;
  }

  return {
    ...desktopCliMetadataOptions(),
    target: {
      launchCommand,
      cliEntry,
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  };
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function runDaemonCliCommand(
  backendEntry: string,
  args: ReadonlyArray<string>,
): ChildProcess.SpawnSyncReturns<string> {
  return ChildProcess.spawnSync(process.execPath, [backendEntry, ...args], {
    cwd: resolveBackendCwd(),
    env: {
      ...backendChildEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    encoding: "utf8",
    windowsHide: true,
  });
}

function formatDaemonCommandFailure(
  command: string,
  result: ChildProcess.SpawnSyncReturns<string>,
): string {
  const stderr = result.stderr?.trim() || "";
  const stdout = result.stdout?.trim() || "";
  return `${command} command failed (${String(result.status)}). ${stderr || stdout || "No output."}`;
}

function parseDaemonStartOutput(raw: string): DaemonStartOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Daemon start returned invalid JSON output: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Daemon start returned malformed payload.");
  }
  const payload = parsed as {
    status?: unknown;
    daemon?: {
      pid?: unknown;
      port?: unknown;
      authToken?: unknown;
      wsUrl?: unknown;
    };
  };
  if (payload.status !== "started" && payload.status !== "already-running") {
    throw new Error("Daemon start returned unexpected status.");
  }
  if (
    typeof payload.daemon?.pid !== "number" ||
    typeof payload.daemon.port !== "number" ||
    typeof payload.daemon.authToken !== "string" ||
    typeof payload.daemon.wsUrl !== "string"
  ) {
    throw new Error("Daemon start returned incomplete daemon details.");
  }
  return {
    status: payload.status,
    daemon: {
      pid: payload.daemon.pid,
      port: payload.daemon.port,
      authToken: payload.daemon.authToken,
      wsUrl: payload.daemon.wsUrl,
    },
  };
}

function parseDaemonStatusOutput(raw: string): DaemonStatusOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Daemon status returned invalid JSON output: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Daemon status returned malformed payload.");
  }
  const payload = parsed as {
    status?: unknown;
    state?: unknown;
  };
  if (payload.status !== "running" && payload.status !== "stopped" && payload.status !== "stale") {
    throw new Error("Daemon status returned unexpected status.");
  }
  if (payload.state === null || payload.state === undefined) {
    return {
      status: payload.status,
      state: null,
    };
  }
  if (
    typeof payload.state !== "object" ||
    payload.state === null ||
    typeof (payload.state as { readonly pid?: unknown }).pid !== "number"
  ) {
    throw new Error("Daemon status returned malformed state payload.");
  }
  return {
    status: payload.status,
    state: {
      pid: (payload.state as { readonly pid: number }).pid,
    },
  };
}

function parseDaemonStopOutput(raw: string): DaemonStopOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Daemon stop returned invalid JSON output: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Daemon stop returned malformed payload.");
  }
  const payload = parsed as {
    status?: unknown;
    pid?: unknown;
  };
  if (
    payload.status !== "already-stopped" &&
    payload.status !== "cleared-stale-state" &&
    payload.status !== "stopped"
  ) {
    throw new Error("Daemon stop returned unexpected status.");
  }
  if (payload.pid !== undefined && typeof payload.pid !== "number") {
    throw new Error("Daemon stop returned malformed pid.");
  }
  return {
    status: payload.status,
    ...(typeof payload.pid === "number" ? { pid: payload.pid } : {}),
  };
}

function startOrConnectBackendDaemon(): void {
  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    throw new Error(`Missing server entry at ${backendEntry}`);
  }

  const daemonArgs = [
    "daemon",
    "start",
    "--mode",
    "desktop",
    "--base-dir",
    BASE_DIR,
    "--port",
    String(backendPort),
    "--auth-token",
    backendAuthToken,
    "--json",
  ];
  if (useDevRenderer) {
    daemonArgs.push("--dev-url", devServerUrl);
  }

  const runStartCommand = (): DaemonStartOutput => {
    const daemonResult = runDaemonCliCommand(backendEntry, daemonArgs);
    if (daemonResult.error) {
      throw daemonResult.error;
    }
    if (daemonResult.status !== 0) {
      throw new Error(formatDaemonCommandFailure("Daemon start", daemonResult));
    }
    return parseDaemonStartOutput(daemonResult.stdout.trim());
  };

  let parsed: DaemonStartOutput;
  try {
    parsed = runStartCommand();
  } catch (startError) {
    const statusResult = runDaemonCliCommand(backendEntry, [
      "daemon",
      "status",
      "--base-dir",
      BASE_DIR,
      "--json",
    ]);
    if (statusResult.error) {
      throw startError;
    }
    if (statusResult.status !== 0) {
      throw startError;
    }
    const status = parseDaemonStatusOutput(statusResult.stdout.trim());
    if (status.status !== "stale" || status.state === null) {
      throw startError;
    }

    writeDesktopLogHeader(
      `daemon stale detected pid=${String(status.state.pid)}; attempting recovery`,
    );
    const stopResult = runDaemonCliCommand(backendEntry, [
      "daemon",
      "stop",
      "--base-dir",
      BASE_DIR,
      "--json",
    ]);
    if (stopResult.error) {
      throw new Error(
        `Failed to stop stale daemon process before recovery: ${formatErrorMessage(stopResult.error)}`,
        {
          cause: startError,
        },
      );
    }
    if (stopResult.status !== 0) {
      throw new Error(formatDaemonCommandFailure("Daemon stop", stopResult), {
        cause: startError,
      });
    }
    parsed = runStartCommand();
  }

  backendManagedByDaemon = true;
  backendPort = parsed.daemon.port;
  backendAuthToken = parsed.daemon.authToken;
  backendWsUrl = parsed.daemon.wsUrl;
  writeDesktopLogHeader(
    `daemon backend ${parsed.status} pid=${String(parsed.daemon.pid)} port=${String(parsed.daemon.port)}`,
  );
}

async function stopDaemonForUpdateInstall(timeoutMs = 10_000): Promise<void> {
  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    throw new Error(`Missing server entry at ${backendEntry}`);
  }

  const stopResult = runDaemonCliCommand(backendEntry, [
    "daemon",
    "stop",
    "--base-dir",
    BASE_DIR,
    "--timeout-ms",
    String(timeoutMs),
    "--json",
  ]);
  if (stopResult.error) {
    throw new Error(
      `Failed to stop daemon for app update install: ${formatErrorMessage(stopResult.error)}`,
      { cause: stopResult.error },
    );
  }
  if (stopResult.status !== 0) {
    throw new Error(formatDaemonCommandFailure("Daemon stop", stopResult));
  }

  const output = parseDaemonStopOutput(stopResult.stdout.trim());
  writeDesktopLogHeader(
    `daemon stop for update status=${output.status}${output.pid ? ` pid=${String(output.pid)}` : ""}`,
  );
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("ace failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopDesktopBackgroundNotifications();
  if (!backendManagedByDaemon) {
    stopBackend();
  }
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (useDevRenderer || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: DesktopMenuAction): void {
  withReadyPrimaryWindow((window) => {
    window.webContents.send(MENU_ACTION_CHANNEL, action);
  });
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.ACE_DISABLE_AUTO_UPDATE === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `ace ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = buildApplicationMenuTemplate({
    appName: APP_DISPLAY_NAME,
    platform: process.platform,
    onCheckForUpdates: handleCheckForUpdatesMenuClick,
    onMenuAction: dispatchMenuAction,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function configureMacDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock || !app.isReady()) {
    return;
  }

  const iconPath = resolveIconPath("icns") ?? resolveIconPath("png");
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    writeDesktopLogHeader(`dock icon load failed path=${sanitizeLogValue(iconPath)}`);
    return;
  }

  app.dock.setIcon(icon);
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from the runtime app name,
 * which can vary between development and packaged builds.
 *
 * We override it to stable filesystem-friendly names (`ace` / `ace-dev`)
 * so shell-facing profile directories stay predictable across platforms.
 */
function resolveUserDataPath(): string {
  return resolveDesktopUserDataPath({
    platform: process.platform,
    userDataDirName: USER_DATA_DIR_NAME,
  });
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "linux") {
    (app as LinuxDesktopNamedApp).setDesktopName?.(LINUX_DESKTOP_ENTRY_NAME);
  }

  configureMacDockIcon();
}

function quoteDesktopAutostartExecArgument(value: string): string {
  return `"${value.replace(/(["\\`$])/g, "\\$1")}"`;
}

function ensureLinuxDaemonAutostartEntry(): void {
  const autostartDir = Path.join(OS.homedir(), ".config", "autostart");
  const entryPath = Path.join(
    autostartDir,
    isDevelopment ? "ace-dev-daemon.desktop" : "ace-daemon.desktop",
  );
  const execCommand = [process.execPath, DAEMON_LOGIN_ITEM_ARG]
    .map(quoteDesktopAutostartExecArgument)
    .join(" ");
  const entryContents = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=ace daemon",
    "Comment=Start the ace background daemon at login",
    `Exec=${execCommand}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  FS.mkdirSync(autostartDir, { recursive: true });
  const previousContents = FS.existsSync(entryPath) ? FS.readFileSync(entryPath, "utf8") : null;
  if (previousContents !== entryContents) {
    FS.writeFileSync(entryPath, entryContents, "utf8");
  }
  writeDesktopLogHeader(
    `daemon autostart entry ready path=${sanitizeLogValue(entryPath)} changed=${String(previousContents !== entryContents)}`,
  );
}

function ensureDaemonAutostartRegistration(): void {
  if (!app.isPackaged) {
    return;
  }

  try {
    if (process.platform === "linux") {
      ensureLinuxDaemonAutostartEntry();
      return;
    }

    if (process.platform === "win32") {
      const query = {
        path: process.execPath,
        args: [DAEMON_LOGIN_ITEM_ARG],
      };
      const current = app.getLoginItemSettings(query);
      if (!current.openAtLogin) {
        app.setLoginItemSettings({
          openAtLogin: true,
          ...query,
        });
      }
      const next = app.getLoginItemSettings(query);
      writeDesktopLogHeader(`daemon autostart login item openAtLogin=${String(next.openAtLogin)}`);
      return;
    }

    const current = app.getLoginItemSettings();
    if (!current.openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
      });
    }
    const next = app.getLoginItemSettings();
    writeDesktopLogHeader(`daemon autostart login item openAtLogin=${String(next.openAtLogin)}`);
  } catch (error) {
    writeDesktopLogHeader(
      `daemon autostart registration failed error=${sanitizeLogValue(formatErrorMessage(error))}`,
    );
  }
}

function shouldRunHeadlessDaemonBootstrap(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.argv.includes(DAEMON_LOGIN_ITEM_ARG)) {
    return true;
  }

  if (process.platform !== "darwin") {
    return false;
  }

  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

function getInAppBrowserSession(): Electron.Session {
  return session.fromPartition(IN_APP_BROWSER_PARTITION);
}

function flushInAppBrowserSessionStorage(): void {
  try {
    const browserSession = getInAppBrowserSession();
    browserSession.flushStorageData();
  } catch (error) {
    writeDesktopLogHeader(
      `in-app browser session lookup failed error=${sanitizeLogValue(formatErrorMessage(error))}`,
    );
  }
}

async function repairInAppBrowserStorage(): Promise<boolean> {
  try {
    const browserSession = getInAppBrowserSession();
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    browserSession.flushStorageData();
    writeDesktopLogHeader("in-app browser storage repaired");
    return true;
  } catch (error) {
    writeDesktopLogHeader(
      `in-app browser storage repair failed error=${sanitizeLogValue(formatErrorMessage(error))}`,
    );
    return false;
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function emitCliInstallState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(CLI_STATE_CHANNEL, cliInstallState);
  }
}

function setCliInstallState(state: DesktopCliInstallState): void {
  cliInstallState = state;
  emitCliInstallState();
}

function getDesktopCliReadyMessage(result: AceCliInstallResult): string {
  if (!result.ready) {
    return "The `ace` command is still unavailable after installation.";
  }
  if (!result.changed) {
    return "The `ace` command is already ready to use.";
  }
  if (result.restartRequired) {
    return "CLI installed. Open a new terminal window to use `ace`.";
  }
  return "The `ace` command is ready to use.";
}

async function installDesktopCli(
  reason: "startup" | "settings",
): Promise<DesktopCliInstallActionResult> {
  if (cliInstallInFlight) {
    return {
      accepted: false,
      completed: false,
      state: cliInstallState,
    } satisfies DesktopCliInstallActionResult;
  }

  const options = resolveDesktopCliInstallOptions();
  const checkedAt = new Date().toISOString();
  if (!options) {
    const state = createUnsupportedCliInstallState(checkedAt);
    setCliInstallState(state);
    writeDesktopLogHeader(
      `cli install unavailable reason=${sanitizeLogValue(state.message ?? "")}`,
    );
    return {
      accepted: false,
      completed: false,
      state,
    } satisfies DesktopCliInstallActionResult;
  }

  const inspectedState = inspectAceCliInstall(options);
  if (reason === "startup" && inspectedState.ready) {
    const nextState = createDesktopCliInstallStateFromInspect(inspectedState, {
      checkedAt,
      message: "The `ace` command is already ready to use.",
    });
    setCliInstallState(nextState);
    return {
      accepted: true,
      completed: true,
      state: nextState,
    } satisfies DesktopCliInstallActionResult;
  }

  const setInstallProgressState = (progressPercent: number | null, message: string) => {
    setCliInstallState(
      createPendingDesktopCliInstallState({
        ...desktopCliMetadataOptions(),
        status: "installing",
        checkedAt,
        progressPercent,
        message,
      }),
    );
  };

  cliInstallInFlight = true;
  setInstallProgressState(0, "Installing the `ace` CLI. (0%)");
  writeDesktopLogHeader(`cli install start reason=${reason}`);

  try {
    const result = ensureAceCliInstalledWithProgress(options, (progress) => {
      setInstallProgressState(
        progress.percent,
        `${progress.message} (${String(progress.percent)}%)`,
      );
    });
    const nextState = createDesktopCliInstallStateFromResult(result, {
      checkedAt: new Date().toISOString(),
      message: getDesktopCliReadyMessage(result),
    });
    setCliInstallState(nextState);
    writeDesktopLogHeader(
      `cli install complete reason=${reason} ready=${String(nextState.status === "ready")} restartRequired=${String(result.restartRequired)}`,
    );
    return {
      accepted: true,
      completed: nextState.status === "ready",
      state: nextState,
    } satisfies DesktopCliInstallActionResult;
  } catch (error) {
    const message = formatErrorMessage(error);
    const inspectedState = inspectAceCliInstall(options);
    const nextState = createDesktopCliInstallStateFromInspect(inspectedState, {
      checkedAt: new Date().toISOString(),
      status: "error",
      message,
    });
    setCliInstallState(nextState);
    writeDesktopLogHeader(
      `cli install failed reason=${reason} message=${sanitizeLogValue(message)}`,
    );
    return {
      accepted: true,
      completed: false,
      state: nextState,
    } satisfies DesktopCliInstallActionResult;
  } finally {
    cliInstallInFlight = false;
  }
}

function scheduleStartupCliInstall(window: BrowserWindow): void {
  if (!app.isPackaged) {
    return;
  }

  let started = false;
  const startInstall = () => {
    if (started) {
      return;
    }
    started = true;
    writeDesktopLogHeader("startup cli install trigger");
    void installDesktopCli("startup");
  };

  const fallback = setTimeout(() => {
    writeDesktopLogHeader("startup cli install fallback trigger");
    startInstall();
  }, 2_000);

  window.webContents.once("did-finish-load", () => {
    clearTimeout(fallback);
    startInstall();
  });
}

function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.ACE_DISABLE_AUTO_UPDATE === "1",
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<boolean> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return false;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return false;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    return true;
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  updateInstallInFlight = true;
  clearUpdatePollTimer();
  try {
    setUpdateState({
      message: "Preparing update: stopping background services.",
      errorContext: null,
    });
    if (backendManagedByDaemon) {
      await stopDaemonForUpdateInstall();
    } else {
      await stopBackendAndWaitForExit();
    }
    // Destroy all windows before launching the NSIS installer to avoid the installer finding live windows it needs to close.
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    // `quitAndInstall()` only starts the handoff to the updater. The actual
    // install may still fail asynchronously, so keep the action incomplete
    // until we either quit or receive an updater error.
    autoUpdater.quitAndInstall(true, true);
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    updateInstallInFlight = false;
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.ACE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  if (process.env.ACE_DESKTOP_MOCK_UPDATES) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${process.env.ACE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
    });
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (updateInstallInFlight) {
      updateInstallInFlight = false;
      isQuitting = false;
      setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
      console.error(`[desktop-updater] Updater error: ${message}`);
      return;
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;
  backendManagedByDaemon = false;

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const captureBackendLogs = app.isPackaged && backendLogSink !== null;
  const child = ChildProcess.spawn(
    process.execPath,
    [backendEntry, "serve", "--bootstrap-fd", "3"],
    {
      cwd: resolveBackendCwd(),
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      env: {
        ...backendChildEnv(),
        ELECTRON_RUN_AS_NODE: "1",
        ACE_DAEMONIZED: "1",
        ACE_CLI_SUPPRESS_BOOT_BANNER: "1",
      },
      stdio: captureBackendLogs
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit", "pipe"],
    },
  );
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        aceHome: BASE_DIR,
        authToken: backendAuthToken,
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    child.kill("SIGTERM");
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
  ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
    event.returnValue = backendWsUrl;
  });

  ipcMain.removeAllListeners(GET_IS_DEVELOPMENT_BUILD_CHANNEL);
  ipcMain.on(GET_IS_DEVELOPMENT_BUILD_CHANNEL, (event) => {
    event.returnValue = isDevelopmentBuild;
  });

  ipcMain.removeAllListeners(GET_WINDOW_SHOWN_AT_CHANNEL);
  ipcMain.on(GET_WINDOW_SHOWN_AT_CHANNEL, (event) => {
    event.returnValue = mainWindowShownAtMs;
  });

  ipcMain.removeAllListeners(GET_TITLEBAR_LEFT_INSET_CHANNEL);
  ipcMain.on(GET_TITLEBAR_LEFT_INSET_CHANNEL, (event) => {
    const owner =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? mainWindow;
    event.returnValue = resolveTitlebarLeftInset(owner);
  });

  ipcMain.removeHandler(GET_NOTIFICATION_PERMISSION_CHANNEL);
  ipcMain.handle(GET_NOTIFICATION_PERMISSION_CHANNEL, async () =>
    getDesktopNotificationPermission(),
  );

  ipcMain.removeHandler(REQUEST_NOTIFICATION_PERMISSION_CHANNEL);
  ipcMain.handle(REQUEST_NOTIFICATION_PERMISSION_CHANNEL, async () =>
    requestDesktopNotificationPermission(),
  );

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(REPAIR_BROWSER_STORAGE_CHANNEL);
  ipcMain.handle(REPAIR_BROWSER_STORAGE_CHANNEL, async () => {
    return repairInAppBrowserStorage();
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
          disabled: item.disabled === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            enabled: !item.disabled,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(SHOW_NOTIFICATION_CHANNEL);
  ipcMain.handle(SHOW_NOTIFICATION_CHANNEL, async (_event, rawInput: unknown) => {
    const input = getSafeDesktopNotificationInput(rawInput);
    if (!input) {
      return false;
    }

    return showDesktopNotification(input);
  });

  ipcMain.removeHandler(CLOSE_NOTIFICATION_CHANNEL);
  ipcMain.handle(CLOSE_NOTIFICATION_CHANNEL, async (_event, rawId: unknown) => {
    if (typeof rawId !== "string") {
      return false;
    }

    const id = rawId.trim();
    if (id.length === 0) {
      return false;
    }

    return closeDesktopNotification(id);
  });

  ipcMain.removeHandler(CLI_GET_STATE_CHANNEL);
  ipcMain.handle(CLI_GET_STATE_CHANNEL, async () => cliInstallState);

  ipcMain.removeHandler(CLI_INSTALL_CHANNEL);
  ipcMain.handle(CLI_INSTALL_CHANNEL, async () => installDesktopCli("settings"));

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL);
  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    if (!updaterConfigured) {
      return {
        checked: false,
        state: updateState,
      } satisfies DesktopUpdateCheckResult;
    }
    const checked = await checkForUpdates("web-ui");
    return {
      checked,
      state: updateState,
    } satisfies DesktopUpdateCheckResult;
  });

  ipcMain.removeAllListeners(ORCHESTRATION_EVENT_CHANNEL);
  ipcMain.on(ORCHESTRATION_EVENT_CHANNEL, (_event, rawEvent) => {
    if (desktopBackgroundNotificationService && rawEvent) {
      desktopBackgroundNotificationService.handleOrchestrationEvent(rawEvent);
    }
  });

  ipcMain.removeAllListeners(SERVER_CONFIG_EVENT_CHANNEL);
  ipcMain.on(SERVER_CONFIG_EVENT_CHANNEL, (_event, rawEvent) => {
    if (desktopBackgroundNotificationService && rawEvent) {
      desktopBackgroundNotificationService.handleServerConfigEvent(rawEvent);
    }
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function attachWebContentsContextMenu(input: {
  targetContents: Electron.WebContents;
  window: BrowserWindow;
  onMenuShown?: () => void;
}): void {
  input.targetContents.on("context-menu", (event, params) => {
    event.preventDefault();
    input.onMenuShown?.();

    const linkUrl = getSafeExternalUrl(params.linkURL);
    const menuTemplate = buildWebContentsContextMenuTemplate(
      {
        dictionarySuggestions: params.dictionarySuggestions,
        editFlags: params.editFlags,
        misspelledWord: params.misspelledWord,
      },
      {
        ...(linkUrl
          ? {
              onCopyLink: () => clipboard.writeText(linkUrl),
              onOpenLink: () => {
                void shell.openExternal(linkUrl);
              },
            }
          : {}),
        onReplaceMisspelling: (suggestion) => {
          input.targetContents.replaceMisspelling(suggestion);
        },
      },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window: input.window });
  });
}

function setupWebViewEventHandlers(window: BrowserWindow): void {
  attachWebContentsContextMenu({
    targetContents: window.webContents,
    window,
  });

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const safeInitialUrl = getSafeExternalUrl(params.src);
    if (!safeInitialUrl) {
      event.preventDefault();
      return;
    }

    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.partition = IN_APP_BROWSER_PARTITION;
    params.src = safeInitialUrl;
  });

  window.webContents.on("did-attach-webview", (_event, guestContents) => {
    guestContents.setWindowOpenHandler(({ url }) => {
      const externalUrl = getSafeExternalUrl(url);
      if (externalUrl) {
        window.webContents.send(BROWSER_OPEN_URL_CHANNEL, externalUrl);
      }
      return { action: "deny" };
    });
    guestContents.on("before-input-event", (event, input) => {
      const action = resolveBrowserShortcutAction(input);
      if (!action) {
        return;
      }
      event.preventDefault();
      window.webContents.send(BROWSER_SHORTCUT_ACTION_CHANNEL, action);
    });
    attachWebContentsContextMenu({
      targetContents: guestContents,
      window,
      onMenuShown: () => {
        window.webContents.send(BROWSER_CONTEXT_MENU_SHOWN_CHANNEL);
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  setupWebViewEventHandlers(window);

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
  });
  const revealWindow = () => {
    if (window.isDestroyed()) {
      return;
    }
    if (mainWindowShownAtMs === null) {
      mainWindowShownAtMs = Date.now();
    }
    if (!window.isVisible()) {
      window.show();
    }
  };
  const revealFallbackTimer = setTimeout(revealWindow, MAIN_WINDOW_SHOW_FALLBACK_DELAY_MS);
  revealFallbackTimer.unref();
  window.once("ready-to-show", revealWindow);
  window.webContents.once("did-finish-load", revealWindow);

  if (useDevRenderer) {
    void window.loadURL(
      appendDesktopBootstrapWsUrl(devServerUrl, backendWsUrl, isDevelopmentBuild),
    );
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(
      appendDesktopBootstrapWsUrl(
        `${DESKTOP_SCHEME}://app/index.html`,
        backendWsUrl,
        isDevelopmentBuild,
      ),
    );
  }

  window.on("closed", () => {
    clearTimeout(revealFallbackTimer);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  const baseUrl = `ws://127.0.0.1:${backendPort}`;
  backendWsUrl = `${baseUrl}/?token=${encodeURIComponent(backendAuthToken)}`;
  writeDesktopLogHeader(`bootstrap resolved websocket endpoint baseUrl=${baseUrl}`);
  if (useDaemonBackend) {
    startOrConnectBackendDaemon();
    writeDesktopLogHeader("bootstrap daemon start/connect completed");
  } else {
    backendManagedByDaemon = false;
    startBackend();
    writeDesktopLogHeader("bootstrap child backend start completed");
  }
  startDesktopBackgroundNotifications();
  writeDesktopLogHeader("bootstrap desktop background notification service started");

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  mainWindow = createWindow();
  scheduleStartupCliInstall(mainWindow);
  writeDesktopLogHeader("bootstrap main window created");
}

app.on("before-quit", () => {
  isQuitting = true;
  updateInstallInFlight = false;
  stopDesktopBackgroundNotifications();
  for (const notification of activeDesktopNotifications.values()) {
    notification.close();
  }
  activeDesktopNotifications.clear();
  writeDesktopLogHeader("before-quit received");
  flushInAppBrowserSessionStorage();
  clearUpdatePollTimer();
  if (!backendManagedByDaemon) {
    stopBackend();
  }
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    if (useDaemonBackend) {
      ensureDaemonAutostartRegistration();
    }
    if (useDaemonBackend && shouldRunHeadlessDaemonBootstrap()) {
      writeDesktopLogHeader("headless login launch detected; starting daemon only");
      try {
        startOrConnectBackendDaemon();
        writeDesktopLogHeader("headless login daemon start/connect completed");
      } catch (error) {
        writeDesktopLogHeader(
          `headless login daemon bootstrap failed error=${sanitizeLogValue(formatErrorMessage(error))}`,
        );
      }
      isQuitting = true;
      app.quit();
      return;
    }
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      const window = getOrCreatePrimaryWindow();
      focusPrimaryWindow(window);
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isQuitting) {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    stopDesktopBackgroundNotifications();
    clearUpdatePollTimer();
    if (!backendManagedByDaemon) {
      stopBackend();
    }
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    stopDesktopBackgroundNotifications();
    clearUpdatePollTimer();
    if (!backendManagedByDaemon) {
      stopBackend();
    }
    restoreStdIoCapture?.();
    app.quit();
  });
}
