import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  BrowserBackendServerMessage,
  BrowserBackendOperation,
} from "@ace/protocol";
import { BrowserBackend } from "../../src/main/browser/backend.ts";
import { EmbeddedViews } from "../../src/main/browser/views.ts";

/*
 * An Electron main for `views-lifecycle.e2e.ts`: the app's real browser backend and view host,
 * wired to app windows the way `index.ts` and `background.ts` wire them (views leave a closing
 * window for the parking window; a renderer that goes away forgets its placements), and driven
 * with backend requests the way the daemon drives them. `globalThis.harness` is called from the
 * test through Playwright's `app.evaluate`.
 */

if (process.env.ACE_E2E_USER_DATA) app.setPath("userData", process.env.ACE_E2E_USER_DATA);

const backendId = "backend-1";
/** The daemon's session for the thread; a new connection opens a new one. */
let sessionId = "session-1";
const threadId = "thread-1";

/** A page that marks itself once loaded, so a reload (a new document) is visible. */
const marked = `data:text/html,${encodeURIComponent(
  "<!doctype html><title>kept</title><body style='margin:0;background:#3a6'><script>window.loadedAt=performance.timeOrigin+Math.random()</script>",
)}`;

const Response = z.object({ result: z.unknown().optional(), error: z.string().optional() });
const Evaluated = z.object({ result: z.object({ value: z.unknown() }) });
const Opened = z.object({ tabId: z.string() });

let window: BrowserWindow | undefined;
let sequence = 0;
/** Tab events the daemon received, by method, in order. */
const tabEvents: string[] = [];
const TabEvent = z.object({ tabId: z.string(), method: z.string() });
const pending = new Map<string, (response: z.infer<typeof Response>) => void>();

const views = new EmbeddedViews({
  window: () => window,
  partitionsDir: `${app.getPath("userData")}/Partitions`,
  platform: process.platform,
  log: () => {},
});
const backend = new BrowserBackend(views, { log: () => {} });

async function request(operation: z.input<typeof BrowserBackendOperation>): Promise<unknown> {
  const id = `request-${++sequence}`;
  const response = new Promise<z.infer<typeof Response>>((resolve) => pending.set(id, resolve));
  backend.handle(
    BrowserBackendServerMessage.parse({
      type: "browser.backend.request",
      backendId,
      sessionId,
      id,
      operation,
    }),
  );
  const { result, error } = await response;
  if (error !== undefined) throw new Error(error);
  return result;
}

/** Evaluates in a tab (`undefined`: the selected one) and returns the value. */
async function evaluate(expression: string, tabId?: string): Promise<unknown> {
  const params = { expression, returnByValue: true, awaitPromise: true };
  const result = await request(
    tabId
      ? { kind: "cdp", method: "ace.tabs.cdp", params: { tabId, method: "Runtime.evaluate", params } }
      : { kind: "cdp", method: "Runtime.evaluate", params },
  );
  return Evaluated.parse(result).result.value;
}

/** The app window, wired as `index.ts` wires it. */
async function openWindow(): Promise<BrowserWindow> {
  const created = new BrowserWindow({ width: 1000, height: 700, show: true });
  created.on("close", () => views.evacuate(created));
  const rendererId = created.webContents.id;
  created.webContents.on("destroyed", () => views.forgetHost(rendererId));
  created.on("closed", () => {
    if (window === created) window = undefined;
  });
  await created.loadURL("about:blank");
  window = created;
  return created;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No ${what}`);
  return value;
}

/** The thread's selected page's WebContents, found by its document's title. */
function pageContents(): WebContents {
  return required(
    webContents.getAllWebContents().find((each) => each.getTitle() === "kept"),
    "kept page",
  );
}

function expect(actual: unknown, wanted: unknown): void {
  if (actual !== wanted) throw new Error(`Expected ${String(wanted)}, got ${String(actual)}`);
}

function place(bounds: { x: number; y: number; width: number; height: number }) {
  const host = required(window, "window");
  return views.place(
    { threadId, bounds, visible: true },
    { id: host.webContents.id, window: host, zoom: 1 },
  );
}

/** A daemon connection, as `BackendConnection` makes one once registered. */
function attach(connectionId: string): void {
    backend.attach({
      backendId,
      connectionId,
      send: (serialized) => {
        const message = BrowserBackendClientMessage.parse(JSON.parse(serialized));
        if (message.type === "browser.backend.response") {
          pending.get(message.id)?.(Response.parse(message));
          pending.delete(message.id);
        }
        if (message.type === "browser.backend.event") {
          const event = TabEvent.safeParse(message.params);
          if (message.method === "ace.tabs.event" && event.success) {
            tabEvents.push(event.data.method);
            // As the daemon does: re-arm the restarted page, then say it is ready.
            if (event.data.method === "ace.rendererRestarted")
              void request({
                kind: "cdp",
                method: "ace.tabs.cdp",
                params: { tabId: event.data.tabId, method: "ace.rendererReady" },
              });
          } else tabEvents.push(message.method);
        }
        return true;
      },
    });
}

const harness = {
  async start(): Promise<void> {
    attach("desktop-connection");
    await openWindow();
    await request({
      kind: "open",
      options: { threadId, workspaceId: "workspace-1", profile: "ephemeral" },
      viewport: { width: 600, height: 400 },
    });
    await request({ kind: "navigate", url: marked, timeout: 15_000 });
  },
  place,
  /**
   * The page moves from the panel into a small floating frame (scaled from the panel's size,
   * as picture-in-picture places it) and back. Returns every visibility change of its view and
   * each main-frame navigation meanwhile, and where it was while floating.
   */
  async pictureInPicture(
    panel: { x: number; y: number; width: number; height: number },
    floating: { x: number; y: number; width: number; height: number },
  ) {
    const host = required(window, "window");
    const contents = pageContents();
    expect(await place(panel), "shown");
    const view = host.contentView.children.find(
      (child) => "webContents" in child && child.webContents === contents,
    );
    if (!view) throw new Error("No view in the app window");
    const visibility: boolean[] = [];
    const setVisible = view.setVisible.bind(view);
    view.setVisible = (visible: boolean) => {
      if (visible !== view.getVisible()) visibility.push(visible);
      setVisible(visible);
    };
    let navigations = 0;
    const navigated = (details: { isMainFrame: boolean }) => {
      if (details.isMainFrame) navigations++;
    };
    contents.on("did-start-navigation", navigated);
    try {
      const pip = await views.place(
        {
          threadId,
          bounds: floating,
          visible: true,
          device: { width: panel.width, height: panel.height },
        },
        { id: host.webContents.id, window: host, zoom: 1 },
      );
      const whileFloating = { receipt: pip, bounds: view.getBounds(), visible: view.getVisible() };
      const back = await place(panel);
      return { whileFloating, back, visibility, navigations, bounds: view.getBounds() };
    } finally {
      contents.off("did-start-navigation", navigated);
      view.setVisible = setVisible;
    }
  },
  /**
   * Split view: the selected tab and a new one placed by id side by side. Returns each view's
   * box and visibility as the window holds them.
   */
  async split(
    left: { x: number; y: number; width: number; height: number },
    right: { x: number; y: number; width: number; height: number },
  ) {
    const host = required(window, "window");
    const listed = z
      .object({ activeTabId: z.string(), tabs: z.array(z.object({ tabId: z.string() })) })
      .parse(await request({ kind: "cdp", method: "ace.tabs.list" }));
    // Another tab of the thread: the one already open beside it, else a new one.
    const tabId =
      listed.tabs.find((tab) => tab.tabId !== listed.activeTabId)?.tabId ??
      Opened.parse(await request({ kind: "cdp", method: "ace.tabs.open" })).tabId;
    const at = { id: host.webContents.id, window: host, zoom: 1 };
    const receipts = [
      await views.place({ threadId, tabId: listed.activeTabId, bounds: left, visible: true }, at),
      await views.place({ threadId, tabId, bounds: right, visible: true }, at),
    ];
    const boxes = host.contentView.children
      .filter((child) => child.getVisible())
      .map((child) => child.getBounds())
      .toSorted((a, b) => a.x - b.x);
    // Back to one tab for what follows.
    await views.place({ threadId, tabId, bounds: right, visible: false }, at);
    await views.place({ threadId, tabId: listed.activeTabId, bounds: left, visible: false }, at);
    await place(left);
    return { receipts, boxes };
  },
  /** The page's own load mark: unchanged as long as the document was never reloaded. */
  loadedAt: () => evaluate("window.loadedAt"),
  closeWindow(): Promise<void> {
    const closing = required(window, "window");
    const closed = new Promise<void>((resolve) => closing.once("closed", () => resolve()));
    closing.close();
    return closed;
  },
  openWindow: async () => {
    await openWindow();
  },
  /** Where the selected page's view is now: in which window, how big, and what the page sees. */
  async where() {
    const contents = pageContents();
    const windows = BrowserWindow.getAllWindows();
    const appWindow = window && !window.isDestroyed() ? window : undefined;
    const inApp = appWindow?.contentView.children.find(
      (child) => "webContents" in child && child.webContents === contents,
    );
    return {
      destroyed: contents.isDestroyed(),
      inAppWindow: inApp !== undefined,
      bounds: inApp?.getBounds(),
      visible: inApp?.getVisible() ?? false,
      appWindows: windows.length,
      inner: inApp
        ? await contents.executeJavaScript("({ width: innerWidth, height: innerHeight })")
        : undefined,
    };
  },
  resizeWindow(width: number, height: number) {
    required(window, "window").setContentSize(width, height);
  },
  /** A second tab, opened in the background and given a page that counts its frames. */
  async backgroundTab(): Promise<string> {
    const { tabId } = Opened.parse(await request({ kind: "cdp", method: "ace.tabs.open" }));
    await request({
      kind: "cdp",
      method: "ace.tabs.cdp",
      params: {
        tabId,
        method: "Page.navigate",
        params: { url: "data:text/html,<title>background</title><canvas id=c></canvas>" },
      },
    });
    return tabId;
  },
  /**
   * Crash the selected page's renderer each time it comes back, `times` times; returns what
   * the daemon heard and whether the page was given up on (not reloaded again).
   */
  async crashRepeatedly(times: number) {
    tabEvents.length = 0;
    const contents = pageContents();
    for (let crash = 1; crash <= times; crash++) {
      contents.forcefullyCrashRenderer();
      if (crash === times) break;
      const restarted = Date.now() + 10_000;
      while (tabEvents.filter((method) => method === "ace.rendererRestarted").length < crash) {
        if (Date.now() > restarted) throw new Error(`No restart after crash ${crash}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    // Long enough for any automatic reload to have started.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return { events: [...tabEvents], crashed: contents.isCrashed() };
  },
  /** The person reloads a crashed page by hand. */
  async reload() {
    tabEvents.length = 0;
    await request({ kind: "cdp", method: "Page.reload" });
    const until = Date.now() + 10_000;
    while (!tabEvents.includes("ace.rendererRestarted") && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return { events: [...tabEvents], crashed: pageContents().isCrashed() };
  },
  /**
   * The person presses ⌘L (Ctrl+L) in the native page and types "go" at once, before the app's
   * address field has focus; the field then takes focus and asks for the keyboard, as the
   * address bar does. Returns what the field holds.
   */
  async typeAfterAddressShortcut(): Promise<unknown> {
    const host = required(window, "window").webContents;
    await host.executeJavaScript(
      "document.body.innerHTML = '<input id=address>'; document.activeElement?.blur(); 0",
    );
    const page = pageContents();
    page.focus();
    const modifier = process.platform === "darwin" ? "meta" : "control";
    page.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: [modifier] });
    page.sendInputEvent({ type: "keyUp", keyCode: "L", modifiers: [modifier] });
    for (const key of ["g", "o"]) {
      page.sendInputEvent({ type: "keyDown", keyCode: key.toUpperCase() });
      page.sendInputEvent({ type: "char", keyCode: key });
      page.sendInputEvent({ type: "keyUp", keyCode: key.toUpperCase() });
    }
    // Input events reach the page's input hooks asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await host.executeJavaScript("document.getElementById('address').focus(); 0");
    views.focusApp(host.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return host.executeJavaScript("document.getElementById('address').value");
  },
  /**
   * The daemon link blips: the connection drops and comes back, and the daemon opens the
   * thread's page again under a new session, as its recovery does.
   */
  async blip() {
    backend.detach();
    attach("desktop-connection-2");
    sessionId = "session-2";
    return request({
      kind: "open",
      options: { threadId, workspaceId: "workspace-1", profile: "ephemeral" },
      viewport: { width: 600, height: 400 },
    });
  },
  /** Frames a tab drew in half a second, and whether it thinks it is visible. */
  async rendering(tabId: string) {
    return evaluate(
      `new Promise((resolve) => { let frames = 0; const end = performance.now() + 500;
        const tick = () => { frames++; performance.now() < end ? requestAnimationFrame(tick) : resolve({ frames, state: document.visibilityState }); };
        requestAnimationFrame(tick); })`,
      tabId,
    );
  },
};

Reflect.set(globalThis, "harness", harness);
// The test closes and reopens app windows: the app must not quit in between.
app.on("window-all-closed", () => {});
// Quit as the app quits (`index.ts`): the views close first, wherever they are.
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void backend.closeAll().finally(() => app.quit());
});
void app.whenReady();
