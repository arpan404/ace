import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeTheme,
  powerMonitor,
  shell,
  type WebContents,
} from "electron";
import type { AppInfo, DeepLink, DesktopSettings } from "../shared/contract.ts";
import { Background } from "./background.ts";
import { daemonLogsPath } from "./daemon/logs.ts";
import { DaemonRuntime, desktopTarget } from "./daemon/runtime.ts";
import type { DaemonTarget } from "./daemon/target.ts";
import { linksFromArgv, parseDeepLink, protocolScheme } from "./deep-link.ts";
import { appearance, createHandlers } from "./handlers.ts";
import { emit, registerHandlers } from "./ipc.ts";
import { claimKeychainName } from "./keychain.ts";
import { applicationMenu } from "./menu.ts";
import { backgroundArgument, startHidden } from "./os/login.ts";
import { checkWithFeedback } from "./os/update-feedback.ts";
import { appPaths } from "./paths.ts";
import { applyDevCsp, registerAppScheme, serveRenderer } from "./renderer.ts";
import { SettingsStore } from "./settings-store.ts";
import { replayChord } from "./shortcuts.ts";
import { checkUserData, desktopUserData, legacyFolders } from "./user-data.ts";
import { createMainWindow } from "./window/main-window.ts";

/** Set at build time; unpackaged runs have no app package.json for `app.getVersion()`. */
declare const ACE_APP_VERSION: string;

const paths = appPaths({
  appDirectory: import.meta.dirname,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
});
// The app's own data folder, checked before Electron puts anything in it: never the older
// ace 0.x app's folders. Development keeps window state, sessions and settings in
// `.ace-dev/electron` (ACE_DESKTOP_USER_DATA).
const userData = desktopUserData({
  explicit: process.env.ACE_DESKTOP_USER_DATA,
  appData: app.getPath("appData"),
});
const unsafe = checkUserData(
  userData,
  legacyFolders({ appData: app.getPath("appData"), homedir: homedir() }),
);
if (unsafe) {
  dialog.showErrorBox("ace can't start", unsafe);
  app.exit(1);
} else {
  app.setPath("userData", userData);
  // Before anything starts Chromium's network service: never the older ace app's keychain item.
  claimKeychainName(app, process.platform);
  registerAppScheme();
  if (!app.requestSingleInstanceLock()) app.quit();
  else
    main(
      // The daemon home, chosen once by the shared resolver (`~/.ace-next` by default).
      desktopTarget({
        env: process.env,
        packaged: app.isPackaged,
        daemonEntry: paths.daemonEntry,
        platform: process.platform,
      }),
    );
}

function log(level: "info" | "warn" | "error", message: string): void {
  (level === "error" ? console.error : console.log)(`[${level}] ${message}`);
}

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(target: DaemonTarget): void {
  const info: AppInfo = {
    version: app.isPackaged ? app.getVersion() : ACE_APP_VERSION,
    platform:
      process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
    arch: process.arch,
    electron: process.versions.electron ?? "",
    packaged: app.isPackaged,
  };
  const runtime = new DaemonRuntime({
    target,
    packaged: app.isPackaged,
    version: info.version,
    resources: {
      entry: paths.daemonEntry,
      screenHelper: paths.screenHelper,
      screenHelperManifest: paths.screenHelperManifest,
      binDirectory: paths.binDirectory,
      node: paths.node,
      packaged: app.isPackaged,
    },
    env: process.env,
    log,
  });
  const settings = new SettingsStore(join(app.getPath("userData"), "desktop-settings.json"));
  let window: BrowserWindow | undefined;
  let rendererUrl = "";
  let route = "/";
  const pending: DeepLink[] = [];
  const contents = (): WebContents | undefined => window?.webContents;

  const background = new Background({
    userData: app.getPath("userData"),
    trayIcon: paths.trayIcon,
    browserPreload: join(dirname(paths.preload), "browser-preload.cjs"),
    runtime,
    settings: () => settings.get(),
    window: () => window,
    open: (link) => open(link),
    quitAll: () => app.quit(),
    log: (message) => log("warn", message),
    onController: (state) => emit(contents(), "browser.controller", state),
  });

  /** Show the window (creating it if needed) and follow a deep link. */
  function open(link?: DeepLink): void {
    if (!app.isReady()) {
      if (link) pending.push(link);
      return;
    }
    if (!window || window.isDestroyed()) createWindow();
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
    if (link) {
      if (window?.webContents.isLoading()) pending.push(link);
      else emit(contents(), "deep-link", link);
    }
  }

  function focusChanged(): void {
    const match = /^\/t\/([^/]+)/.exec(route);
    background.setFocus(
      Boolean(window?.isFocused()),
      match?.[1] ? decodeURIComponent(match[1]) : undefined,
    );
  }

  function createWindow(): void {
    window = createMainWindow({
      url: rendererUrl,
      preload: paths.preload,
      info: JSON.stringify(info),
      statePath: join(app.getPath("userData"), "window.json"),
      onRoute: (path) => {
        route = path;
        focusChanged();
      },
      onState: (state) => {
        emit(contents(), "window.changed", state);
        focusChanged();
      },
    });
    window.webContents.once("did-finish-load", () => {
      for (const link of pending.splice(0)) emit(contents(), "deep-link", link);
    });
    // A reloaded or crashed page can no longer hide the browser views it placed.
    const renderer = window.webContents;
    const rendererId = renderer.id;
    const forget = () => background.forgetBrowserHost(rendererId);
    renderer.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) forget();
    });
    renderer.on("render-process-gone", forget);
    renderer.on("destroyed", forget);
    window.on("closed", () => {
      window = undefined;
      // Embedded views live in the window: without one the app stops offering the backend,
      // so the daemon pauses or moves those sessions instead of driving dead views.
      background.windowChanged();
      focusChanged();
    });
    background.windowChanged();
  }

  function applySettings(next: DesktopSettings): void {
    background.settingsChanged(next);
    // Login items belong to the installed app; development builds never register one.
    if (
      app.isPackaged &&
      process.platform !== "linux" &&
      app.getLoginItemSettings().openAtLogin !== next.openAtLogin
    )
      app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: [backgroundArgument] });
    globalShortcut.unregisterAll();
    if (next.globalShortcut)
      try {
        globalShortcut.register(next.globalShortcut, () => open({ kind: "new-thread" }));
      } catch (error) {
        log("warn", `Global shortcut ${next.globalShortcut} is not available: ${String(error)}`);
      }
    emit(contents(), "settings.changed", next);
  }

  // Deep links: `ace://` on every platform, folders from "Open in ace", and the dock.
  const launchArgs = process.argv.slice(process.defaultApp ? 2 : 1);
  pending.push(...linksFromArgv(launchArgs, isDirectory));
  // Development never claims `ace://` from the installed app unless asked to.
  if (app.isPackaged) app.setAsDefaultProtocolClient(protocolScheme);
  else if (process.env.ACE_DESKTOP_REGISTER_PROTOCOL === "1" && process.argv[1])
    app.setAsDefaultProtocolClient(protocolScheme, process.execPath, [resolve(process.argv[1])]);
  app.on("second-instance", (_event, argv) => {
    const links = linksFromArgv(argv.slice(process.defaultApp ? 2 : 1), isDirectory);
    if (links.length === 0) open();
    for (const link of links) open(link);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) open(link);
  });
  app.on("open-file", (event, path) => {
    event.preventDefault();
    if (isDirectory(path)) open({ kind: "open-folder", path });
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    // The browser backend tells the daemon first, then the daemon this app started stops.
    void background
      .stop()
      .then(() => runtime.stop())
      .catch((error: unknown) => log("error", String(error)))
      .finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (!settings.get().background && process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => open());

  void app.whenReady().then(async () => {
    if (paths.devIcon) app.dock?.setIcon(paths.devIcon);
    const devUrl = process.env.ACE_DESKTOP_RENDERER_URL;
    // A remote-only app lets the person enter a daemon, which must use TLS (`wss:`).
    const remote =
      runtime.target.kind === "remote"
        ? [new URL(runtime.target.url).origin]
        : runtime.target.kind === "remote-only"
          ? ["wss:"]
          : [];
    if (devUrl && !app.isPackaged) {
      applyDevCsp(devUrl, remote);
      rendererUrl = devUrl;
    } else rendererUrl = await serveRenderer(paths.renderer, remote);

    // The page shows "Starting ace…" until its daemon answers, however long a first start
    // takes. Only a real failure rejects; the page then shows its connection screen and
    // reloads once the daemon is running again.
    let missedConnection = false;
    const connection = async () => {
      try {
        return await runtime.connection();
      } catch (error) {
        missedConnection = true;
        throw error;
      }
    };
    runtime.onStatus((status) => {
      if (status.state !== "running" || !missedConnection) return;
      missedConnection = false;
      window?.webContents.reload();
    });
    /** The daemon's log folder (or home) in the file manager; false when there is none here. */
    const showLogs = async (): Promise<boolean> => {
      const path = daemonLogsPath(runtime.target, existsSync);
      if (!path) return false;
      return (await shell.openPath(path)) === "";
    };
    const handlers = createHandlers({
      info,
      runtime,
      settings,
      background,
      window: () => window,
      env: process.env,
      connection,
      quit: () => app.quit(),
      showLogs,
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        applicationMenu({
          platform: process.platform,
          appName: app.name,
          developer: !app.isPackaged,
          trigger: (accelerator) => {
            if (window && !window.isDestroyed())
              replayChord(window.webContents, accelerator, process.platform);
          },
          checkForUpdates: () =>
            void checkWithFeedback({
              check: async () => handlers["updates.check"](undefined),
              report: (status) => emit(contents(), "updates.status", status),
              timers,
            }),
          openUrl: (url) => void shell.openExternal(url).catch(() => {}),
          showLogs: () =>
            void showLogs().catch((error: unknown) =>
              log("warn", `Could not show the logs: ${String(error)}`),
            ),
        }),
      ),
    );
    registerHandlers({
      rendererUrl,
      isAppWindow: (sender) => sender === window?.webContents,
      handlers,
    });
    nativeTheme.on("updated", () => emit(contents(), "theme.changed", appearance()));
    runtime.onStatus((status) => emit(contents(), "daemon.status", status));
    settings.onChange(applySettings);
    powerMonitor.on("resume", () => {
      background.wake();
      emit(contents(), "system.resumed", undefined);
    });

    applySettings(settings.get());
    // Launched at login with background mode on: daemon and tray only, no window.
    const hidden = startHidden({
      platform: process.platform,
      argv: process.argv,
      wasOpenedAtLogin:
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin,
      background: settings.get().background,
    });
    if (!hidden) createWindow();
    // The background link follows the daemon from here on: it attaches whenever one is ready.
    background.start();
    void runtime
      .start()
      .catch((error: unknown) => log("error", `Daemon start failed: ${String(error)}`));
  });
}
