import { z } from "zod";
import type {
  BrowserBackend,
  BackendOpen,
  BrowserBackendPage,
  BrowserBackendSession,
} from "./backend.ts";
import { cancellableCdp } from "./cancellable-cdp.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { ChromeHost, type ChromeLease } from "./chrome-host.ts";
import type { ChromeCleanup, ChromeLaunch } from "./chrome-instance.ts";
import { chromeInput } from "./chrome-input.ts";
import { ChromeTabs, type TabHost } from "./chrome-tabs.ts";
import { modelScreenshot } from "./model-screenshot.ts";

export interface ChromeBackendOptions {
  executable(signal: AbortSignal): Promise<string>;
  /** Where Chrome writes downloads before they are quarantined, per profile. */
  stagingDir(profileDir: string): string;
  platform: NodeJS.Platform;
  launch: ChromeLaunch;
  cleanup: ChromeCleanup;
}
const Png = z.object({ data: z.string().max(64 * 1024 * 1024) });

/**
 * ace's own Chrome for Testing, driven over a pipe. One host per profile is shared by every
 * thread; a thread gets tabs in the persistent profile, or in a throwaway context when its
 * browser is ephemeral. A crashed browser is restarted and the thread's page reopened.
 */
export class ChromeBackend implements BrowserBackend {
  readonly kind = "headless";
  private hosts = new Map<string, ChromeHost>();
  private options: ChromeBackendOptions;
  constructor(options: ChromeBackendOptions) {
    this.options = options;
  }
  /** Stops every browser this backend started. Sessions must be closed first. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.hosts.values()].map((host) => host.close()));
  }
  private host(profileDir: string): ChromeHost {
    let host = this.hosts.get(profileDir);
    if (!host) {
      host = new ChromeHost({
        executable: (signal) => this.options.executable(signal),
        profileDir,
        stagingDir: this.options.stagingDir(profileDir),
        platform: this.options.platform,
        launch: this.options.launch,
        cleanup: this.options.cleanup,
      });
      this.hosts.set(profileDir, host);
    }
    return host;
  }
  async open(request: BackendOpen): Promise<BrowserBackendSession> {
    request.signal.throwIfAborted();
    const host = this.host(request.profileDir);
    const isolated = request.options.profile !== "persistent";
    const tabs = new ChromeTabs(
      request,
      this.options.launch.deviceScaleFactor,
      this.options.cleanup.schedule,
    );
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let lease: ChromeLease | undefined;
    let current: TabHost | undefined;
    let closing: Promise<void> | undefined;
    let recovering: Promise<void> | undefined;
    const connect = async (): Promise<TabHost> => {
      lease = await host.acquire(signal);
      const instance = lease.instance;
      const browserContextId = isolated
        ? await instance.targets.createContext(instance.stagingDir)
        : undefined;
      current = { instance, browserContextId };
      void instance.exited.then((reason) => {
        if (current?.instance === instance && !signal.aborted) recover(reason);
      });
      return current;
    };
    const release = () => {
      lease?.release();
      lease = undefined;
    };
    /** The browser died or wedged: start another and bring this thread's page back. */
    const recover = (reason: string) => {
      if (recovering) return;
      release();
      recovering = (async () => {
        const next = await connect();
        await tabs.restore(next);
        request.restarted?.();
      })()
        .catch((error: unknown) => {
          if (signal.aborted) return;
          request.lost(
            `${reason}; the browser could not restart: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          recovering = undefined;
        });
    };
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        lifetime.abort();
        request.signal.removeEventListener("abort", abort);
        const targets = tabs.targets();
        tabs.stop();
        await recovering?.catch(() => {});
        const owned = current;
        // Not awaited: a wedged browser must not hold the thread open. A stopping
        // browser takes its pages with it.
        if (owned && !owned.instance.connection.closed) {
          const { instance, browserContextId } = owned;
          const pages: Promise<unknown> = browserContextId
            ? instance.targets.disposeContext(browserContextId)
            : Promise.all(targets.map((id) => instance.targets.close(id)));
          void pages.catch(() => {});
        }
        release();
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      await tabs.start(await connect());
      signal.throwIfAborted();
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
    /** One tab's page; without an id, whichever tab the person is shown. */
    const pageOf = (id?: string): BrowserBackendPage => {
      const cdp = () => (id === undefined ? tabs.current() : tabs.tab(id)).cdp;
      const input = chromeInput(cdp, this.options.platform);
      const tabId = () => id ?? tabs.active();
      return {
        get cdp() {
          return cancellableCdp(cdp(), signal);
        },
        frames: () => tabs.frames(tabId()),
        pageStatus: () => tabs.pageStatus(tabId()),
        networkBody: (requestId) => tabs.inspection.body(requestId),
        url: () => tabs.url(tabId()),
        navigate: async (url, _timeout, navigation) => {
          // The session owns the load budget; it pauses during policy waits.
          const page = cdp();
          const stop = () => void page.send("Page.stopLoading").catch(() => {});
          navigation?.addEventListener("abort", stop, { once: true });
          try {
            await navigateCdp(
              page,
              url,
              navigation ? AbortSignal.any([signal, navigation]) : signal,
            );
          } finally {
            navigation?.removeEventListener("abort", stop);
          }
        },
        click: (x, y) => input.click(x, y),
        insertText: (text) => input.insertText(text),
        press: (key) => input.press(key),
        wheel: (x, y) => input.wheel(x, y),
        screenshot: async (format) => {
          if (format === "jpeg") return modelScreenshot(cdp());
          const { data } = Png.parse(await cdp().send("Page.captureScreenshot", { format: "png" }));
          return Buffer.from(data, "base64");
        },
        resize: (width, height) => tabs.resize(width, height, tabId()),
        viewport: () => tabs.viewportSize(tabId()),
        media: async (colorScheme) => {
          await cdp().send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: colorScheme }],
          });
        },
      };
    };
    const pages = new Map<string, BrowserBackendPage>();
    const page = (id: string) => {
      tabs.tab(id);
      let entry = pages.get(id);
      if (!entry) {
        entry = pageOf(id);
        pages.set(id, entry);
      }
      for (const known of pages.keys())
        if (!tabs.list().some((tab) => tab.tabId === known)) pages.delete(known);
      return entry;
    };
    const shown = pageOf();
    return {
      ...shown,
      // A spread copies a getter's value; the shown tab's page must stay live.
      get cdp() {
        return shown.cdp;
      },
      tabs: {
        list: () => tabs.list(),
        active: () => tabs.active(),
        open: (options) => tabs.open(options),
        switch: (id) => tabs.switch(id),
        close: (id) => tabs.close(id),
        dialog: () => tabs.dialog(),
        answer: (id, accept, text) => tabs.answer(id, accept, text),
        downloads: () => tabs.downloads.transfers.list(),
        page,
      },
      privateMode: (enabled) => {
        tabs.inspection.privacy(enabled);
        tabs.downloads.transfers.privacy(enabled);
      },
      controller: async (controller, tabId) => {
        tabs.lease(controller.controller, tabId);
      },
      close,
    };
  }
}
