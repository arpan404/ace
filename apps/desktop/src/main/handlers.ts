import { writableFolder } from "./browser/download-folder.ts";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  nativeImage,
  nativeTheme,
  type OpenDialogOptions,
} from "electron";
import { shell } from "electron";
import type {
  AppInfo,
  DaemonConnection,
  NativeAppearance,
  VisualizationWindow,
  WindowBackground,
} from "../shared/contract.ts";
import type { DiagnosticReport } from "../shared/diagnostics.ts";
import type { DoctorReport } from "../shared/onboarding.ts";
import type { Background } from "./background.ts";
import type { DaemonRuntime } from "./daemon/runtime.ts";
import type { Handlers } from "./ipc.ts";
import { writeClipboardImage } from "./os/clipboard.ts";
import { openInEditor, reveal } from "./os/editor.ts";
import { appIdentities, systemApplication, systemApplicationIcon } from "./os/app-identity.ts";
import { editorIcons } from "./os/editor-icon.ts";
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
  authorizeDaemon(url: string): void;
  quit(): void;
  updateKeymap?(bindings: Record<string, string>): void;
  /** Opens the daemon's and the app's log folders; false when there is nothing to show. */
  showLogs(): Promise<boolean>;
  /** A page diagnostic for the desktop log; rate-limited, never throws. */
  reportDiagnostic(report: DiagnosticReport): void;
  /** Problems the app found itself (the `ace` command), listed after the doctor's checks. */
  desktopChecks(): DoctorReport["checks"];
  /** The page's theme colours, for the window behind it (now and from the next launch). */
  setWindowBackground(value: WindowBackground): void;
  /** A chat visualization in its own window, in the locked visualization session. */
  openVisualization(request: VisualizationWindow): void;
}): Handlers {
  const { runtime, settings, background } = options;
  const editorIcon = editorIcons(
    {
      forProtocol: async (url) => (await app.getApplicationInfoForProtocol(url)).icon,
      forFile: (path) => app.getFileIcon(path, { size: "normal" }),
    },
    process.platform,
  );
  const appIdentity = appIdentities({
    application: (bundleId) => systemApplication(bundleId, process.platform),
    icon: (path) => systemApplicationIcon(path, process.platform),
  });
  const requireWindow = () => {
    const window = options.window();
    if (!window) throw new Error("No window");
    return window;
  };
  return {
    "keymap.update": (bindings) => {
      options.updateKeymap?.(bindings);
      return undefined;
    },
    "app.info": () => options.info,
    "app.quit": () => {
      options.quit();
      return undefined;
    },
    "daemon.connection": () => options.connection(),
    "daemon.authorize": (url) => {
      options.authorizeDaemon(url);
      return undefined;
    },
    "daemon.status": () => runtime.current(),
    "daemon.restart": () => runtime.restart(),
    "daemon.diagnose": async () => {
      const report = await runtime.diagnose();
      return { ...report, checks: [...report.checks, ...options.desktopChecks()].slice(0, 64) };
    },
    "daemon.showLogs": () => options.showLogs(),
    "daemon.pause": (paused) => runtime.pause(paused),
    "onboarding.providers": () => runtime.providers(),
    "system.toolchains": () => detectToolchains(options.env),
    "shell.openInEditor": (request) => openInEditor(request),
    "shell.reveal": (request) => reveal(request.path),
    "shell.appIdentity": (request) => appIdentity(request.bundleId),
    "shell.editorIcon": (request) => editorIcon(request.editor),
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
    "clipboard.writeImage": async (request) => {
      await writeClipboardImage(request, {
        decode: (bytes) => nativeImage.createFromBuffer(bytes),
        writePng: (png) =>
          clipboard.write([
            new ClipboardItem({
              "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }),
            }),
          ]),
      });
      return undefined;
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
    "theme.setWindowBackground": (value) => {
      options.setWindowBackground(value);
      return undefined;
    },
    "visualization.open": (request) => {
      options.openVisualization(request);
      return undefined;
    },
    "settings.get": () => settings.get(),
    "settings.update": async (patch) => {
      // A downloads folder must be one this app can save in, now.
      if (patch.browserDownloads) await writableFolder(patch.browserDownloads);
      return settings.update(patch);
    },
    "permissions.status": () => permissions(),
    "permissions.open": (pane) => openPermissionPane(pane),
    "browser.place": (placement, sender) => {
      const window = sender && BrowserWindow.fromWebContents(sender);
      // Bounds are the page's CSS pixels; the view is placed in window DIPs.
      if (window)
        return background.placeBrowser(placement, {
          id: sender.id,
          window,
          zoom: sender.getZoomFactor(),
        });
      return "unavailable";
    },
    "browser.snapshot": async (request) =>
      (await background.snapshotBrowser(request.threadId, request.tabId)) ?? null,
    "browser.page": (request) => background.browserPage(request),
    "browser.focus-app": (_request, sender) => {
      if (sender) background.focusApp(sender.id);
      return undefined;
    },
    "diagnostics.report": (report) => {
      options.reportDiagnostic(report);
      return undefined;
    },
    // The release feed check pulls in @ace/service and tar; load them only when asked.
    "updates.check": async () =>
      (await import("./os/updates.ts")).checkForUpdate(options.info.version),
  };
}
