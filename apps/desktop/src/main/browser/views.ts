import { WebContentsView, session as sessions, type BaseWindow, type WebContents } from "electron";
import type { BrowserPlacement } from "../../shared/contract.ts";
import type { CdpTarget, ViewHost } from "./backend.ts";

export interface ViewHostOptions {
  window(): BaseWindow | undefined;
  /** Per-site approval through the daemon; local origins never ask. */
  allowOrigin(sessionId: string, origin: string): Promise<boolean>;
  log(message: string): void;
}

const local = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The app's in-app browser: Electron's own Chromium in `WebContentsView`s drawn inside the
 * thread's Browser panel. Each workspace gets an isolated persistent partition, never the
 * app's session or the person's Chrome profile. Popups, downloads and permission prompts are
 * refused, as in the daemon's browser service; non-local origins need a per-site approval.
 */
export class EmbeddedViews implements ViewHost {
  private views = new Map<string, WebContentsView>();
  private configured = new Set<string>();
  private options: ViewHostOptions;

  constructor(options: ViewHostOptions) {
    this.options = options;
  }

  open(request: { sessionId: string; workspaceId: string; url?: string }): CdpTarget {
    const partition = `persist:ace-browser-${request.workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    this.configure(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    const contents = view.webContents;
    sessionIds.set(contents.id, request.sessionId);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    this.views.set(request.sessionId, view);
    this.options.window()?.contentView.addChildView(view);
    contents.debugger.attach("1.3");
    void contents.loadURL(request.url ?? "about:blank").catch(() => {});
    return target(contents, () => this.close(request.sessionId));
  }

  /** Draw (or hide) a session's view where the renderer's Browser panel is. */
  place(placement: BrowserPlacement): void {
    const view = this.views.get(placement.sessionId);
    if (!view) return;
    const { x, y, width, height } = placement.bounds;
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
    // Hidden views stay alive (and attached) but stop painting.
    view.setVisible(placement.visible && width > 0 && height > 0);
  }

  close(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    this.views.delete(sessionId);
    this.options.window()?.contentView.removeChildView(view);
    if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
    view.webContents.close();
  }

  closeAll(): void {
    for (const sessionId of [...this.views.keys()]) this.close(sessionId);
  }

  private configure(partition: string): void {
    if (this.configured.has(partition)) return;
    this.configured.add(partition);
    const session = sessions.fromPartition(partition);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
    const approved = new Set<string>();
    session.webRequest.onBeforeRequest((details, callback) => {
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return callback({ cancel: true });
      }
      if (["devtools:", "data:", "blob:", "about:"].includes(url.protocol)) return callback({});
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password)
        return callback({ cancel: true });
      if (local.has(url.hostname) || approved.has(url.origin)) return callback({});
      const sessionId = details.webContentsId === undefined ? undefined : sessionIds.get(details.webContentsId);
      if (!sessionId) return callback({ cancel: true });
      void this.options
        .allowOrigin(sessionId, url.origin)
        .then((allowed) => {
          if (allowed) approved.add(url.origin);
          callback({ cancel: !allowed });
        })
        .catch(() => callback({ cancel: true }));
    });
  }
}

const sessionIds = new Map<number, string>();

function target(contents: WebContents, close: () => void): CdpTarget {
  // CDP input from the agent also produces input events; ignore those briefly.
  let agentInputUntil = 0;
  return {
    async send(method, params) {
      if (method.startsWith("Input.")) agentInputUntil = Date.now() + 250;
      const result: unknown = await contents.debugger.sendCommand(method, params);
      return typeof result === "object" && result !== null ? { ...result } : {};
    },
    onEvent(listener) {
      const handler = (_event: Electron.Event, method: string, params: unknown) =>
        listener(method, typeof params === "object" && params !== null ? { ...params } : {});
      contents.debugger.on("message", handler);
      return () => contents.debugger.off("message", handler);
    },
    onHumanInput(listener) {
      const handler = (_event: Electron.Event, input: Electron.InputEvent) => {
        if (Date.now() < agentInputUntil) return;
        if (/^(mouseDown|keyDown|rawKeyDown|mouseWheel|gestureScrollBegin|touchStart)$/.test(input.type))
          listener();
      };
      contents.on("input-event", handler);
      return () => contents.off("input-event", handler);
    },
    url: () => contents.getURL(),
    close: () => {
      sessionIds.delete(contents.id);
      close();
    },
  };
}
