import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { ViewHost } from "./backend.ts";
import { EmbeddedPageGroup } from "./page-group.ts";

const Message = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** One raw DevTools connection: commands in, every event out. */
class Cdp {
  private socket: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(e: Error): void }>();
  private listeners = new Set<(method: string, params: unknown) => void>();
  readonly ready: Promise<void>;
  constructor(url: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = Message.parse(JSON.parse(String(data)));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method)
        for (const listener of this.listeners) listener(message.method, message.params);
    });
    this.socket.on("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("Browser view closed"));
      this.pending.clear();
    });
  }
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Browser view closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }
  on(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.listeners.clear();
    this.socket.terminate();
  }
}

const Created = z.object({ targetId: z.string() });
const Context = z.object({ browserContextId: z.string() });
const TargetInfo = z.object({
  targetInfo: z.object({
    targetId: z.string(),
    type: z.string(),
    url: z.string(),
    title: z.string(),
    openerId: z.string().optional(),
  }),
});
const DownloadBegin = z.object({
  frameId: z.string(),
  guid: z.string(),
  url: z.string(),
  suggestedFilename: z.string(),
});
const DownloadProgress = z.object({
  guid: z.string(),
  receivedBytes: z.number(),
  state: z.enum(["inProgress", "completed", "canceled"]),
});
const NavigateResult = z.object({
  loaderId: z.string().optional(),
  errorText: z.string().optional(),
});
const Frame = z.object({ frame: z.object({ url: z.string(), parentId: z.string().optional() }) });

const keyCodes: Record<string, [number, string?]> = {
  Enter: [13, "\r"],
  Tab: [9],
  Escape: [27],
  Backspace: [8],
  Delete: [46],
  Space: [32, " "],
  ArrowLeft: [37],
  ArrowUp: [38],
  ArrowRight: [39],
  ArrowDown: [40],
};
const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

interface Download {
  chromeGuid: string;
  guid: string;
  page: ChromeTabPage;
  state: "inProgress" | "completed" | "canceled";
  bytes: number;
  resumed: boolean;
}

/**
 * One native tab, as the page group sees it, backed by a real Chrome page target instead of an
 * Electron `WebContentsView`. What Electron does natively the desktop's way (window-open handler,
 * paused download items, page titles) is reported with the same `ace.*` events `page.ts` sends.
 */
class ChromeTabPage {
  readonly targetId: string;
  private cdpConnection: Cdp;
  private host: ChromeViewsHost;
  private downloadDir: string | undefined;
  private size = { width: 1280, height: 720 };
  private address = "about:blank";
  private events = new Set<(method: string, params: unknown) => void>();
  private closed = false;
  constructor(host: ChromeViewsHost, targetId: string, cdp: Cdp, downloadDir: string | undefined) {
    this.host = host;
    this.targetId = targetId;
    this.cdpConnection = cdp;
    this.downloadDir = downloadDir;
    cdp.on((method, params) => {
      if (method === "Page.frameNavigated") {
        const frame = Frame.safeParse(params);
        if (frame.success && !frame.data.frame.parentId) this.address = frame.data.frame.url;
      }
      // Electron reports `page-title-updated` once the document's title is parsed; Chrome's
      // target info keeps the address as the title until much later, so read it at load.
      if (method === "Page.domContentEventFired" || method === "Page.loadEventFired")
        void cdp
          .send("Runtime.evaluate", { expression: "document.title", returnByValue: true })
          .then((raw) => {
            const title = z.object({ result: z.object({ value: z.string() }) }).safeParse(raw);
            if (title.success && title.data.result.value)
              this.emit("ace.title", { title: title.data.result.value });
          })
          .catch(() => {});
      this.emit(method, params);
    });
  }
  emit(method: string, params: unknown): void {
    for (const listener of this.events) listener(method, params);
  }
  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("Browser view closed");
    if (method === "ace.ping") return { alive: true, crashed: false };
    if (method === "ace.download.resume" || method === "ace.download.cancel") {
      const { guid } = z.object({ guid: z.string() }).parse(params);
      await this.host.downloadCommand(guid, method === "ace.download.resume");
      return {};
    }
    if (method.startsWith("ace.")) return {};
    return this.cdpConnection.send(method, params);
  }
  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  /** The person's own input never reaches a headless stand-in. */
  onHumanInput(): () => void {
    return () => {};
  }
  /** Parked views have no picture, as the desktop's own unplaced views. */
  async picture(): Promise<string | undefined> {
    return undefined;
  }
  /** As Electron's `loadURL`: settles on the main frame's DOMContentLoaded or its failure. */
  async navigate(url: string, timeoutMs: number): Promise<string> {
    await this.cdpConnection.send("Page.enable");
    const loaded = Promise.withResolvers<void>();
    let loader: string | undefined;
    const stop = this.cdpConnection.on((method, params) => {
      if (method !== "Page.lifecycleEvent") return;
      const event = z.object({ name: z.string(), loaderId: z.string() }).safeParse(params);
      if (event.success && event.data.name === "DOMContentLoaded" && event.data.loaderId === loader)
        loaded.resolve();
    });
    await this.cdpConnection.send("Page.setLifecycleEventsEnabled", { enabled: true });
    const timer = setTimeout(() => loaded.reject(new Error("Navigation timed out")), timeoutMs);
    try {
      const result = NavigateResult.parse(await this.cdpConnection.send("Page.navigate", { url }));
      if (result.errorText) throw new Error(result.errorText);
      loader = result.loaderId;
      if (loader) await loaded.promise;
      return this.address;
    } finally {
      clearTimeout(timer);
      stop();
    }
  }
  async press(key: string): Promise<void> {
    const parts = key.split("+");
    const name = parts.pop() ?? key;
    const modifiers = parts.reduce((bits, part) => bits | (modifierBits[part] ?? 0), 0);
    const [code, text] = keyCodes[name] ?? [name.toUpperCase().charCodeAt(0), name];
    const base = { key: name, windowsVirtualKeyCode: code, modifiers };
    await this.cdpConnection.send("Input.dispatchKeyEvent", {
      type: text && !modifiers ? "keyDown" : "rawKeyDown",
      ...base,
      ...(text && !modifiers ? { text } : {}),
    });
    await this.cdpConnection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  async resize(width: number, height: number): Promise<void> {
    await this.cdpConnection.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    });
    this.size = { width, height };
  }
  setNativeInput(): void {}
  setAgentControl(agent: boolean): void {
    void this.cdpConnection
      .send("Page.setInterceptFileChooserDialog", { enabled: agent })
      .catch(() => {});
  }
  url(): string {
    return this.address;
  }
  viewport() {
    return this.size;
  }
  /** Parked: the stand-in never places a view in a window. */
  place(): void {}
  async placementReady(): Promise<void> {}
  isShown(): boolean {
    return false;
  }
  saveDownload(guid: string): string | undefined {
    return this.downloadDir ? join(this.downloadDir, guid) : undefined;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.events.clear();
    this.cdpConnection.close();
    await this.host.closeTarget(this.targetId);
  }
}

/** A real Chrome whose page targets stand in for the desktop's native views. */
class ChromeViewsHost {
  private browser: Cdp;
  private endpoint: string;
  private downloadsDir: string;
  private pages = new Map<string, ChromeTabPage>();
  private downloads = new Map<string, Download>();
  private popups = new Map<string, string>();
  constructor(browser: Cdp, endpoint: string, downloadsDir: string) {
    this.browser = browser;
    this.endpoint = endpoint;
    this.downloadsDir = downloadsDir;
    browser.on((method, params) => this.browserEvent(method, params));
  }
  async start(): Promise<void> {
    await this.browser.send("Target.setDiscoverTargets", { discover: true });
  }
  private browserEvent(method: string, params: unknown): void {
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = TargetInfo.safeParse(params);
      if (!info.success) return;
      const { targetId, type, url, title, openerId } = info.data.targetInfo;
      const own = this.pages.get(targetId);
      if (own) return own.emit("ace.title", { title });
      // Electron denies a page's new window and asks to follow it in the opener's tab instead.
      const opener = openerId ? this.pages.get(openerId) : undefined;
      if (method === "Target.targetCreated" && opener && type === "page")
        this.popups.set(targetId, openerId ?? "");
      const from = this.pages.get(this.popups.get(targetId) ?? "");
      if (from && /^https?:/.test(url)) {
        this.popups.delete(targetId);
        void this.closeTarget(targetId);
        from.emit("ace.popupRequested", { url });
      }
      return;
    }
    if (method === "Browser.downloadWillBegin") {
      const begin = DownloadBegin.parse(params);
      const page = this.pages.get(begin.frameId) ?? this.pages.values().next().value;
      if (!page?.saveDownload("probe")) return;
      const guid = `native-${randomUUID()}`;
      this.downloads.set(guid, {
        chromeGuid: begin.guid,
        guid,
        page,
        state: "inProgress",
        bytes: 0,
        resumed: false,
      });
      page.emit("ace.download.started", {
        guid,
        url: begin.url,
        filename: begin.suggestedFilename,
        mimeType: "",
      });
      return;
    }
    if (method === "Browser.downloadProgress") {
      const progress = DownloadProgress.parse(params);
      const download = [...this.downloads.values()].find((d) => d.chromeGuid === progress.guid);
      if (!download) return;
      download.state = progress.state;
      download.bytes = progress.receivedBytes;
      void this.settle(download);
    }
  }
  /** Electron's download item stays paused until the daemon resumes it; Chrome's finishes. */
  async downloadCommand(guid: string, resume: boolean): Promise<void> {
    const download = this.downloads.get(guid);
    if (!download) return;
    if (!resume) {
      await this.browser
        .send("Browser.cancelDownload", { guid: download.chromeGuid })
        .catch(() => {});
      this.downloads.delete(guid);
      download.page.emit("ace.download.progress", {
        guid,
        bytes: download.bytes,
        state: "cancelled",
      });
      return;
    }
    download.resumed = true;
    await this.settle(download);
  }
  private async settle(download: Download): Promise<void> {
    if (!download.resumed || download.state === "inProgress") return;
    this.downloads.delete(download.guid);
    const target = download.page.saveDownload(download.guid);
    if (download.state === "completed" && target) {
      await copyFile(join(this.downloadsDir, download.chromeGuid), target);
      download.page.emit("ace.download.progress", {
        guid: download.guid,
        bytes: download.bytes,
        state: "completed",
      });
    } else
      download.page.emit("ace.download.progress", {
        guid: download.guid,
        bytes: download.bytes,
        state: "cancelled",
      });
  }
  async openPage(context: string, downloadDir: string | undefined): Promise<ChromeTabPage> {
    const { targetId } = Created.parse(
      await this.browser.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: context,
      }),
    );
    const connection = new Cdp(`ws://${this.endpoint}/devtools/page/${targetId}`);
    await connection.ready;
    const page = new ChromeTabPage(this, targetId, connection, downloadDir);
    this.pages.set(targetId, page);
    return page;
  }
  async closeTarget(targetId: string): Promise<void> {
    this.pages.delete(targetId);
    await this.browser.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  /** Each thread's views share one partition, as a browser context. */
  async context(): Promise<string> {
    const { browserContextId } = Context.parse(
      await this.browser.send("Target.createBrowserContext", { disposeOnDetach: true }),
    );
    await this.browser.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      browserContextId,
      downloadPath: this.downloadsDir,
      eventsEnabled: true,
    });
    return browserContextId;
  }
  async dispose(context: string): Promise<void> {
    await this.browser
      .send("Target.disposeBrowserContext", { browserContextId: context })
      .catch(() => {});
  }
}

/**
 * Views as the desktop makes them (each thread a real `EmbeddedPageGroup`), where every native
 * tab is a page of one real headless Chrome. Lets the daemon's relay drive real pages without
 * Electron.
 */
export async function chromeViews(executablePath: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-chrome-views-"));
  const child = spawn(
    executablePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(root, "profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      "--window-size=1280,720",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const browserUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (found?.[1]) resolve(found[1]);
    });
    child.once("exit", () => reject(new Error(`Chrome exited: ${output.slice(0, 500)}`)));
  });
  const browser = new Cdp(browserUrl);
  await browser.ready;
  const host = new ChromeViewsHost(browser, new URL(browserUrl).host, root);
  await host.start();
  const views: ViewHost = {
    async open(request) {
      const context = await host.context();
      const group = new EmbeddedPageGroup(
        (_id) => host.openPage(context, request.downloadDir),
        () => host.dispose(context),
      );
      await group.openTab();
      return group;
    },
  };
  const close = async () => {
    browser.close();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    // Windows: the killed browser's helpers hold profile files open until they notice and exit.
    if (process.platform === "win32")
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await rm(root, { recursive: true, force: true });
  };
  return { views, close };
}
