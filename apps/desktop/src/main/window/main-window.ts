import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import type { WindowState } from "../../shared/contract.ts";
import { isAppUrl, isExternalUrl } from "../csp.ts";
import { restoreBounds, SavedWindow } from "./bounds.ts";
import { macTitleBarCss, solidBackground, titleBarSymbolColor, windowOptions } from "./options.ts";

export interface MainWindowOptions {
  url: string;
  preload: string;
  info: string;
  statePath: string;
  onRoute(path: string): void;
  onState(state: WindowState): void;
}

/** Reduce transparency (macOS), reported to the page with the rest of the native appearance. */
export function reducedTransparency(): boolean {
  return process.platform === "darwin" && nativeTheme.prefersReducedTransparency;
}

export function windowState(window: BrowserWindow): WindowState {
  return {
    focused: window.isFocused(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
}

/**
 * The app window: chrome per platform, size and position persisted, and locked to its
 * own origin. Links to other sites open in the system browser; nothing opens new windows.
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const saved = readSaved(options.statePath);
  const areas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map(
    (display) => display.workArea,
  );
  const bounds = restoreBounds(saved, areas);
  const window = new BrowserWindow(
    windowOptions({
      platform: process.platform,
      bounds,
      preload: options.preload,
      info: options.info,
      dark: nativeTheme.shouldUseDarkColors,
    }),
  );
  if (bounds.maximized) window.maximize();
  if (bounds.fullScreen) window.setFullScreen(true);

  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    // Only the trusted renderer can open its local blob wrapper. Authored content has no
    // allow-popups token. This viewer gets no preload bridge or Node privileges.
    if (url.startsWith("blob:") && isAppUrl(url.slice(5), options.url))
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "ace visualization",
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: "",
          },
        },
      };
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url, options.url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url, options.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("did-navigate-in-page", (_event, url) => options.onRoute(new URL(url).pathname));
  contents.on("did-navigate", (_event, url) => options.onRoute(new URL(url).pathname));
  contents.on("dom-ready", () => {
    if (process.platform === "darwin") void contents.insertCSS(macTitleBarCss).catch(() => {});
  });
  // Light and dark can change while ace runs; the window behind the page follows.
  const themeChanged = () => {
    if (window.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    if (process.platform === "win32")
      window.setTitleBarOverlay({ symbolColor: titleBarSymbolColor(dark) });
    window.setBackgroundColor(solidBackground(dark));
  };
  nativeTheme.on("updated", themeChanged);
  window.once("closed", () => nativeTheme.off("updated", themeChanged));
  // Retry while the dev server starts. Packaged builds load from disk; if that ever fails,
  // a few retries are enough and an endless reload loop would only burn CPU.
  let retries = app.isPackaged ? 3 : Number.POSITIVE_INFINITY;
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || retries <= 0) return;
    retries--;
    setTimeout(() => void window.loadURL(url).catch(() => {}), 500);
  });
  window.once("ready-to-show", () => window.show());

  const emit = () => options.onState(windowState(window));
  for (const name of [
    "focus",
    "blur",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ] as const)
    window.on(name as "focus", emit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(window, options.statePath), 400);
  };
  window.on("resize", persist);
  window.on("move", persist);
  window.on("close", () => void save(window, options.statePath));
  void window.loadURL(options.url).catch(() => {});
  return window;
}

function readSaved(path: string): SavedWindow | undefined {
  try {
    const parsed = SavedWindow.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function save(window: BrowserWindow, path: string): Promise<void> {
  if (window.isDestroyed()) return;
  const bounds = window.getNormalBounds();
  const value: SavedWindow = {
    ...bounds,
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
  await writeFile(path, JSON.stringify(value)).catch(() => {});
}
