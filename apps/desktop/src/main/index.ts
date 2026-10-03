import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeTheme,
  powerMonitor,
  type WebContents,
} from "electron";
import type { AppInfo, DeepLink, DesktopSettings } from "../shared/contract.ts";
import { Background } from "./background.ts";
import { DaemonRuntime } from "./daemon/runtime.ts";
import { linksFromArgv, parseDeepLink, protocolScheme } from "./deep-link.ts";
import { appearance, createHandlers } from "./handlers.ts";
import { emit, registerHandlers } from "./ipc.ts";
import { acceleratorToKey, applicationMenu } from "./menu.ts";
import { appPaths } from "./paths.ts";
import { applyDevCsp, registerAppScheme, serveRenderer } from "./renderer.ts";
import { SettingsStore } from "./settings-store.ts";
import { createMainWindow } from "./window/main-window.ts";

/** Set at build time; unpackaged runs have no app package.json for `app.getVersion()`. */
declare const ACE_APP_VERSION: string;

// Development keeps window state, sessions and settings in `.ace-dev/electron`.
if (process.env.ACE_DESKTOP_USER_DATA)
  app.setPath("userData", resolve(process.env.ACE_DESKTOP_USER_DATA));
registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function log(level: "info" | "warn" | "error", message: string): void {
  (level === "error" ? console.error : console.log)(`[${level}] ${message}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(): void {
  const paths = appPaths({
    appDirectory: __dirname,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  });
  const info: AppInfo = {
    version: app.isPackaged ? app.getVersion() : ACE_APP_VERSION,
    platform:
      process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
    arch: process.arch,
    electron: process.versions.electron ?? "",
    packaged: app.isPackaged,
  };
  const runtime = new DaemonRuntime({
    packaged: app.isPackaged,
    version: info.version,
    resources: {
      entry: paths.daemonEntry,
      screenHelper: paths.screenHelper,
      screenHelperManifest: paths.screenHelperManifest,
      binDirectory: paths.binDirectory,
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
    runtime,
    settings: () => settings.get(),
    window: () => window,
    open: (link) => open(link),
    quitAll: () => app.quit(),
    log: (message) => log("warn", message),
    onController: (sessionId, controller) =>
      emit(contents(), "browser.controller", { sessionId, controller }),
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
    window.on("closed", () => {
      window = undefined;
      background.views.closeAll();
      focusChanged();
    });
  }

  function applySettings(next: DesktopSettings): void {
    background.settingsChanged(next);
    // Login items belong to the installed app; development builds never register one.
    if (
      app.isPackaged &&
      process.platform !== "linux" &&
      app.getLoginItemSettings().openAtLogin !== next.openAtLogin
    )
      app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ["--background"] });
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
    const devUrl = process.env.ACE_DESKTOP_RENDERER_URL;
    const remote = runtime.target.kind === "remote" ? [new URL(runtime.target.url).origin] : [];
    if (devUrl && !app.isPackaged) {
      applyDevCsp(devUrl, remote);
      rendererUrl = devUrl;
    } else rendererUrl = await serveRenderer(paths.renderer, remote);

    // The page waits for its daemon at boot. If the daemon is not up within a few seconds the
    // page falls back to its connection screen, and reloads once the daemon is running.
    let missedConnection = false;
    const connection = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          runtime.connection(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              missedConnection = true;
              reject(new Error("The daemon is still starting"));
            }, 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    runtime.onStatus((status) => {
      if (status.state !== "running" || !missedConnection) return;
      missedConnection = false;
      window?.webContents.reload();
    });
    const handlers = createHandlers({
      info,
      runtime,
      settings,
      background,
      window: () => window,
      env: process.env,
      connection,
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        applicationMenu({
          platform: process.platform,
          appName: app.name,
          trigger: (command, accelerator) => {
            emit(contents(), "menu.command", command);
            const key = acceleratorToKey(accelerator, process.platform);
            for (const type of ["keyDown", "keyUp"] as const)
              window?.webContents.sendInputEvent({
                type,
                keyCode: key.keyCode,
                modifiers: key.modifiers,
              });
          },
          checkForUpdates: () =>
            void Promise.resolve(handlers["updates.check"](undefined)).then((status) =>
              emit(contents(), "updates.status", status),
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
    // Launched at login (`--background`): daemon and tray only, no window.
    const hidden = process.argv.includes("--background");
    if (!hidden) createWindow();
    void runtime
      .start()
      .then(() => background.start())
      .catch((error: unknown) => log("error", `Daemon start failed: ${String(error)}`));
  });
}
