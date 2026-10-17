import { BrowserService, detectChromium, type BrowserBackend } from "@ace/browser";
import { defineBrowserConformance } from "@ace/browser/conformance";
import { chromeViews } from "./chrome-views-test-support.ts";
import { connectDesktop, relayDaemon } from "./relay-test-support.ts";

/**
 * The desktop's embedded engine (ADR 0055, 0085): the daemon's `BrowserService` drives the
 * desktop's real backend, connection and page groups over the real relay socket. Each native
 * tab is a real Chrome page standing in for Electron's `WebContentsView`.
 */
const executablePath = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());

/** Any fallback to ace's own Chrome fails loudly instead of passing for the desktop. */
const noChrome: BrowserBackend = {
  kind: "headless",
  open: () => Promise.reject(new Error("Only the desktop's views run in this suite")),
};

defineBrowserConformance({
  name: "desktop native view (embedded)",
  unavailable: executablePath ? undefined : "no Chromium to stand in for Electron's views",
  knownFailures: {
    // TODO(browser): EmbeddedTabs pauses the thread's browser ("Browser view closed") when the
    // shown native tab closes, instead of showing another tab.
    tabs: "closing the shown tab pauses the whole browser",
    // TODO(browser): EmbeddedTabs never turns relayed `ace.tabs.event` console and network
    // events into log entries; only the single-page relay path logs them.
    logs: "console and network logs stay empty for native tabs",
  },
  async start({ options, cleanup }) {
    const cleanups: (() => unknown)[] = [];
    cleanup(async () => {
      for (const close of cleanups.splice(0).toReversed()) await close();
    });
    const chrome = await chromeViews(executablePath ?? "");
    cleanups.push(chrome.close);
    const service = new BrowserService({
      ...options,
      headlessBackend: noChrome,
      backendPreference: () => "embedded",
      tabLifecycle: false,
      ffmpeg: "",
    });
    cleanups.push(() => service.close());
    const daemon = await relayDaemon(cleanups, {
      register: (_id, transport) => service.registerEmbedded(transport),
    });
    await connectDesktop(cleanups, daemon, chrome.views);
    return service;
  },
});
