import { modelScreenshot } from "./model-screenshot.ts";
import type { BrowserBackend, BackendOpen, BrowserBackendSession } from "./backend.ts";
import { cancellableCdp } from "./cancellable-cdp.ts";
import { sizeHeadlessContents } from "./headless-size.ts";
import { HeadlessTabs } from "./headless-tabs.ts";
import { chromiumCloser, type ChromiumCleanupRuntime } from "./chromium-close.ts";
import { launchContext, type ContextLauncher } from "./io.ts";

export class HeadlessBackend implements BrowserBackend {
  readonly kind = "headless";
  private executable: () => Promise<string>;
  private launch: ContextLauncher;
  constructor(
    executable: () => Promise<string>,
    launch: ContextLauncher = launchContext,
    privateCleanup: Partial<ChromiumCleanupRuntime> = {},
  ) {
    this.executable = executable;
    this.launch = launch;
    this.cleanup = privateCleanup;
  }
  private cleanup: Partial<ChromiumCleanupRuntime>;
  async open(request: BackendOpen): Promise<BrowserBackendSession> {
    request.signal.throwIfAborted();
    const executablePath = await new Promise<string>((accept, fail) => {
      const abort = () => {
        request.signal.removeEventListener("abort", abort);
        fail(new Error("Browser launch cancelled"));
      };
      request.signal.addEventListener("abort", abort, { once: true });
      void this.executable()
        .then(accept, fail)
        .finally(() => request.signal.removeEventListener("abort", abort));
      if (request.signal.aborted) abort();
    });
    request.signal.throwIfAborted();
    const context = await this.launch(request.profileDir, {
      executablePath,
      headless: true,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      args: ["--force-device-scale-factor=2"],
      serviceWorkers: "block",
      acceptDownloads: true,
      ...(request.downloadDir ? { downloadsPath: request.downloadDir } : {}),
      chromiumSandbox: true,
      timeout: 30_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const closer = chromiumCloser(context, this.cleanup);
    const sessionLifetime = new AbortController();
    const sessionSignal = AbortSignal.any([request.signal, sessionLifetime.signal]);
    let closed = false;
    let closing: Promise<void> | undefined;
    let tabs: HeadlessTabs | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      sessionLifetime.abort();
      request.signal.removeEventListener("abort", abort);
      tabs?.stop();
      // Cancellation and explicit teardown share the original process-close promise.
      // Repeated Playwright closes can otherwise finish before that shutdown completes.
      closing = closer.close();
      return closing;
    };
    const abort = () => {
      void close().catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      request.signal.throwIfAborted();
      await closer.ready(sessionSignal);
      request.signal.throwIfAborted();
      await context.clearPermissions();
      await context.routeWebSocket("**/*", async (route) => {
        try {
          if (await request.allowed(route.url())) route.connectToServer();
          else route.close();
        } catch {
          route.close();
        }
      });
      tabs = new HeadlessTabs(context, request);
      await tabs.start();
      const ownedTabs = tabs;
      const page = () => ownedTabs.current().page;
      const cdp = () => ownedTabs.current().cdp;
      const stopLoading = () => {
        void cdp()
          .send("Page.stopLoading")
          .catch(() => {});
      };
      context.once("close", () => {
        ownedTabs.stop();
        if (!closed) request.lost("Headless browser closed");
      });
      return {
        get cdp() {
          return cancellableCdp(cdp(), sessionSignal);
        },
        tabs: {
          list: () => ownedTabs.list(),
          active: () => ownedTabs.active(),
          open: () => ownedTabs.open(),
          switch: (id) => ownedTabs.switch(id),
          close: (id) => ownedTabs.close(id),
          dialog: () => ownedTabs.dialog(),
          answer: (id, accept, text) => ownedTabs.answer(id, accept, text),
          downloads: () => ownedTabs.downloads.list(),
        },
        frames: () => ownedTabs.frames(),
        pageStatus: () => ownedTabs.current().status.read(),
        privateMode: (enabled) => {
          ownedTabs.inspection.privacy(enabled);
          ownedTabs.downloads.privacy(enabled);
        },
        networkBody: (id) => ownedTabs.inspection.body(id),
        url: () =>
          ownedTabs.list().find((tab) => tab.tabId === ownedTabs.active())?.url ?? "about:blank",
        navigate: async (url, _timeout, signal) => {
          signal?.addEventListener("abort", stopLoading, { once: true });
          try {
            signal?.throwIfAborted();
            // The session's load budget pauses during policy waits.
            await page().goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
          } finally {
            signal?.removeEventListener("abort", stopLoading);
          }
        },
        click: (x, y) => page().mouse.click(x, y),
        insertText: (text) => page().keyboard.insertText(text),
        press: (key) => page().keyboard.press(key),
        wheel: (x, y) => page().mouse.wheel(x, y),
        screenshot: (type) =>
          type === "jpeg" ? modelScreenshot(cdp()) : page().screenshot({ type, timeout: 10_000 }),
        resize: async (width, height) => {
          await page().setViewportSize({ width, height });
          await sizeHeadlessContents(cdp(), width, height);
        },
        viewport: () => page().viewportSize() ?? { width: 1280, height: 720 },
        media: (colorScheme) => page().emulateMedia({ colorScheme }),
        controller: async (lease) => {
          ownedTabs.lease(lease.controller);
        },
        close,
      };
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }
}
