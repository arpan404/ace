import type { BrowserBackend, BackendOpen, BrowserBackendSession } from "./backend.ts";
import { installOriginGuard } from "./origin-guard.ts";
import { launchContext, type ContextLauncher } from "./io.ts";

export class HeadlessBackend implements BrowserBackend {
  readonly kind = "headless";
  private executable: () => Promise<string>;
  private launch: ContextLauncher;
  constructor(executable: () => Promise<string>, launch: ContextLauncher = launchContext) {
    this.executable = executable;
    this.launch = launch;
  }
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
      serviceWorkers: "block",
      acceptDownloads: false,
      chromiumSandbox: true,
      timeout: 30_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    let guard: Awaited<ReturnType<typeof installOriginGuard>> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      request.signal.removeEventListener("abort", abort);
      guard?.close();
      // Cancellation and explicit teardown share the original process-close promise.
      // Repeated Playwright closes can otherwise finish before that shutdown completes.
      closing = context.close();
      return closing;
    };
    const abort = () => {
      void close().catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
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
      const page = context.pages()[0] ?? (await context.newPage());
      context.on("page", (popup) => {
        if (popup !== page) void popup.close().catch(() => {});
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss().catch(() => {});
      });
      page.on("download", (download) => {
        request.downloadDenied?.({
          url: download.url().slice(0, 8192),
          suggestedFilename: download.suggestedFilename().slice(0, 256),
        });
        void download.cancel().catch(() => {});
      });
      const cdp = await context.newCDPSession(page);
      guard = await installOriginGuard(cdp, request.allowed);
      context.once("close", () => {
        guard?.close();
        if (!closed) request.lost("Headless browser closed");
      });
      page.once("close", () => {
        if (!closed) request.lost("Browser page closed");
      });
      await context.route("**/*", async (route) => {
        try {
          await guard?.ready();
          if (
            route.request().frame().page() === page &&
            (await request.allowed(route.request().url()))
          )
            await route.continue();
          else await route.abort("blockedbyclient");
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) request.navigation();
      });
      page.on("console", (message) =>
        request.log({ kind: "console", type: message.type(), text: message.text() }),
      );
      page.on("pageerror", (error) =>
        request.log({ kind: "console", type: "pageerror", text: error.message }),
      );
      context.on("response", (response) =>
        request.log({
          kind: "network",
          type: "response",
          text: `${response.status()} ${response.request().method()} ${response.url()}`,
        }),
      );
      context.on("requestfailed", (req) =>
        request.log({
          kind: "network",
          type: "failed",
          text: `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`,
        }),
      );
      return {
        cdp,
        url: () => page.url(),
        navigate: async (url, timeout) => {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        },
        click: (x, y) => page.mouse.click(x, y),
        insertText: (text) => page.keyboard.insertText(text),
        press: (key) => page.keyboard.press(key),
        wheel: (x, y) => page.mouse.wheel(x, y),
        screenshot: (type) =>
          page.screenshot({ type, ...(type === "jpeg" ? { quality: 70 } : {}), timeout: 10_000 }),
        resize: (width, height) => page.setViewportSize({ width, height }),
        viewport: () => page.viewportSize() ?? { width: 1280, height: 720 },
        media: (colorScheme) => page.emulateMedia({ colorScheme }),
        controller: async () => {},
        close,
      };
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }
}
