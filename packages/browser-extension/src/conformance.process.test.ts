import { join } from "node:path";
import {
  BrowserService,
  UserChromeBackend,
  UserChromeTabsBackend,
  detectChromium,
} from "@ace/browser";
import { defineBrowserConformance } from "@ace/browser/conformance";
import { connectedBrowser } from "./my-chrome-test-support.ts";

/**
 * "Use my Chrome" (ADR 0084): a Chrome for Testing standing in for the person's browser, with
 * ace for Chrome loaded unpacked and the real native host relaying to a daemon-side hub. The
 * thread's tabs run through `UserChromeTabsBackend`, as the daemon's second browser service does.
 */
const executable = process.env.ACE_CHROMIUM_PATH ?? (await detectChromium());

defineBrowserConformance({
  name: "Use my Chrome (extension)",
  unavailable: !executable
    ? "no Chromium found; set ACE_CHROMIUM_PATH"
    : process.platform === "win32"
      ? "the native host is not supported on Windows yet"
      : undefined,
  harnessSkips: {
    // ADR 0086: the person's browser keeps downloads where it saves them, so there is no
    // artifact to read; my-chrome-page-edges.process.test.ts checks the listing and the file.
    downloads: "downloads stay in the person's own download folder, not ace's artifacts",
    "zip-download": "downloads stay in the person's own download folder, not ace's artifacts",
  },
  knownFailures: {
    // Chrome detaches an extension's debugger from a tab showing its PDF viewer (an extension
    // frame of its own), so ace loses the tab. The PDF still shows in the person's browser.
    "pdf-inline": "Chrome detaches extension debuggers from its PDF viewer",
  },
  async start({ options, cleanup }) {
    const cleanups: (() => Promise<void>)[] = [];
    cleanup(async () => {
      for (const close of cleanups.splice(0).toReversed()) await close().catch(() => {});
    });
    const browser = await connectedBrowser(executable ?? "", cleanups);
    return new BrowserService({
      ...options,
      dataDir: join(browser.root, "service"),
      headlessBackend: new UserChromeTabsBackend(
        new UserChromeBackend(browser.hub, process.platform),
      ),
      backendPreference: () => "headless",
      tabLifecycle: false,
      ffmpeg: "",
    });
  },
});
