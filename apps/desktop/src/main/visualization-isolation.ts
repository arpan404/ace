import {
  BrowserWindow,
  session as sessions,
  type App,
  type Session,
  type WebContents,
  type WebPreferences,
} from "electron";
import { visualizationPartition } from "@ace/html/scripts";

/**
 * Chat visualizations run agent-written scripts. They live in their own in-memory session
 * (`visualizationPartition`), reached only through a `<webview>` or a viewer window, so their
 * network layer can refuse everything. Blink's network hints (preconnect, dns-prefetch) skip
 * CSP, so CSP alone cannot keep a page off the network (docs/daemon/html-visualizations.md).
 */

/** A proxy that cannot be reached: nothing the session sends can leave, loopback included. */
const unreachableProxy = { mode: "fixed_servers", proxyRules: "http://0.0.0.0:0" } as const;

/** Only the page's own document and what it builds in memory. */
export function visualizationRequestAllowed(url: string): boolean {
  return (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url === "about:blank" ||
    url === "about:srcdoc"
  );
}

/**
 * Before Chromium starts: Blink's `DnsPrefetchIfNeeded` reads this frame setting, and a resolver
 * lookup from a hint never reaches `webRequest` or the proxy.
 */
export function disableDnsPrefetching(app: App): void {
  app.commandLine.appendSwitch("blink-settings", "dnsPrefetchingEnabled=false");
}

/** Locks the visualization session's network layer. Call once, after `ready`, before any page. */
export async function isolateVisualizationSession(
  session: Session = sessions.fromPartition(visualizationPartition),
): Promise<Session> {
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !visualizationRequestAllowed(details.url) }),
  );
  await session.setProxy({ ...unreachableProxy, proxyBypassRules: "<-loopback>" });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setSpellCheckerEnabled(false);
  session.on("will-download", (event) => event.preventDefault());
  return session;
}

const guestPreferences = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  javascript: true,
  plugins: false,
  webviewTag: false,
  spellcheck: false,
  disableDialogs: true,
  navigateOnDragDrop: false,
  backgroundThrottling: true,
  autoplayPolicy: "document-user-activation-required",
} satisfies WebPreferences;

/**
 * `will-attach-webview` for the app window: only a visualization `<webview>` in the
 * visualization partition, loading a `data:` document, with no preload or Node. Anything else
 * is refused.
 */
export function acceptVisualizationWebview(
  preferences: WebPreferences,
  params: Record<string, string>,
): boolean {
  if (params.partition !== visualizationPartition) return false;
  if (!params.src?.startsWith("data:text/html")) return false;
  delete preferences.preload;
  Reflect.deleteProperty(preferences, "preloadURL");
  Object.assign(preferences, guestPreferences, { partition: visualizationPartition });
  return true;
}

/** A visualization can never open windows, navigate or leave its first document. */
export function guardVisualizationContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || !visualizationRequestAllowed(event.url)) event.preventDefault();
  });
}

/** "Open in window": a plain window in the same locked session, no preload or bridge. */
export function openVisualizationWindow(request: { title: string; url: string }): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    title: request.title,
    webPreferences: { ...guestPreferences, partition: visualizationPartition },
  });
  guardVisualizationContents(window.webContents);
  // The outer document reports its height through its title; keep the visualization's name.
  window.on("page-title-updated", (event) => event.preventDefault());
  void window.loadURL(request.url).catch(() => {});
  return window;
}
