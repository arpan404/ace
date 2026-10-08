import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, nativeTheme, type OpenDialogOptions } from "electron";
import { shell } from "electron";
import type { AppInfo, DaemonConnection, NativeAppearance } from "../shared/contract.ts";
import type { Background } from "./background.ts";
import type { DaemonRuntime } from "./daemon/runtime.ts";
import type { Handlers } from "./ipc.ts";
import { openInEditor, reveal } from "./os/editor.ts";
import { appIcons, editorIcons, spotlightApp } from "./os/editor-icon.ts";
import { openPermissionPane, permissions } from "./os/permissions.ts";
import type { SettingsStore } from "./settings-store.ts";
import { detectToolchains } from "./system/toolchains.ts";
import { reducedTransparency, windowState } from "./window/main-window.ts";

export function appearance(): NativeAppearance {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    highContrast: nativeTheme.shouldUseHighContrastColors,
    reducedTransparency: reducedTransparency(),
    source: nativeTheme.themeSource,
  };
}

/** Every `window.ace` request, already parsed by `registerHandlers`. */
export function createHandlers(options: {
  info: AppInfo;
  runtime: DaemonRuntime;
  settings: SettingsStore;
  background: Background;
  window(): BrowserWindow | undefined;
  env: NodeJS.ProcessEnv;
  /** The renderer's daemon hand-off; may reject while the daemon is still starting. */
  connection(): Promise<DaemonConnection>;
  quit(): void;
  /** Opens the daemon's logs in the file manager; false when there is nothing to show. */
  showLogs(): Promise<boolean>;
}): Handlers {
  const { runtime, settings, background } = options;
  const editorIcon = editorIcons(
    {
      forProtocol: async (url) => (await app.getApplicationInfoForProtocol(url)).icon,
      forFile: (path) => app.getFileIcon(path, { size: "normal" }),
    },
    process.platform,
  );
  const appIcon = appIcons(
    {
      findApp: spotlightApp(
        (command, args) =>
          new Promise((resolve, reject) =>
            execFile(command, args, { timeout: 3_000, encoding: "utf8" }, (error, stdout) =>
              error ? reject(error) : resolve(stdout),
            ),
          ),
      ),
      forFile: (path) => app.getFileIcon(path, { size: "normal" }),
    },
    process.platform,
  );
  const requireWindow = () => {
    const window = options.window();
    if (!window) throw new Error("No window");
    return window;
  };
  return {
    "app.info": () => options.info,
    "app.quit": () => {
      options.quit();
      return undefined;
    },
    "daemon.connection": () => options.connection(),
    "daemon.status": () => runtime.current(),
    "daemon.restart": () => runtime.restart(),
    "daemon.diagnose": () => runtime.diagnose(),
    "daemon.showLogs": () => options.showLogs(),
    "daemon.pause": (paused) => runtime.pause(paused),
    "onboarding.providers": () => runtime.providers(),
    "system.toolchains": () => detectToolchains(options.env),
    "shell.openInEditor": (request) => openInEditor(request),
    "shell.reveal": (request) => reveal(request.path),
    "shell.editorIcon": (request) => editorIcon(request.editor),
    "shell.appIcon": (request) => appIcon(request.bundleId),
    "shell.openExternal": async (url) => {
      await shell.openExternal(url);
      return true;
    },
    "dialog.openFolder": async () => {
      const window = options.window();
      const picker: OpenDialogOptions = {
        title: "Add Project",
        buttonLabel: "Add Project",
        properties: ["openDirectory", "createDirectory"],
      };
      const chosen = window
        ? await dialog.showOpenDialog(window, picker)
        : await dialog.showOpenDialog(picker);
      return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
    },
    "notify.show": (request) =>
      background.alert({
        category: "needsYou",
        id: `renderer-${Date.now()}-${request.title}`,
        threadId: request.threadId,
        title: request.title,
        body: request.body,
        link: request.threadId
          ? { kind: "thread", threadId: request.threadId }
          : { kind: "new-thread" },
      }),
    "badge.set": (count) => {
      background.attention.update({ ...background.attention.current(), needsYou: count });
      return undefined;
    },
    "window.action": (action) => {
      const window = requireWindow();
      if (action === "minimize") window.minimize();
      else if (action === "maximize") {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      } else if (action === "fullscreen") window.setFullScreen(!window.isFullScreen());
      else window.close();
      return windowState(window);
    },
    "window.state": () => windowState(requireWindow()),
    "theme.appearance": () => appearance(),
    "theme.setSource": (source) => {
      nativeTheme.themeSource = source;
      return appearance();
    },
    "settings.get": () => settings.get(),
    "settings.update": (patch) => settings.update(patch),
    "permissions.status": () => permissions(),
    "permissions.open": (pane) => openPermissionPane(pane),
    "browser.place": (placement, sender) => {
      const window = sender && BrowserWindow.fromWebContents(sender);
      // Bounds are the page's CSS pixels; the view is placed in window DIPs.
      if (window)
        background.placeBrowser(placement, {
          id: sender.id,
          window,
          zoom: sender.getZoomFactor(),
        });
      return undefined;
    },
    "browser.control": (request) => {
      background.browserControl(request.threadId, request.controller);
      return undefined;
    },
    // The release feed check pulls in @ace/service and tar; load them only when asked.
    "updates.check": async () =>
      (await import("./os/updates.ts")).checkForUpdate(options.info.version),
  };
}
