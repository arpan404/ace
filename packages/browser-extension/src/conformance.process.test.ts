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
  knownFailures: {
    // TODO(browser): UserChromeTabsBackend lists agent tabs with an empty title.
    navigate: "agent tabs report an empty title",
    // TODO(browser): closing the shown agent tab pauses the thread ("Browser session closed").
    tabs: "closing the shown tab pauses the whole browser",
    // TODO(browser): a target=_blank from an agent tab opens an ordinary tab of the person's
    // that the thread never sees.
    popups: "popups leave the thread's reach",
    // TODO(browser): `dialog()` is always undefined; a click that opens one hangs until the
    // link's 30 s deadline instead of reporting `pending_dialog`.
    dialogs: "dialogs are never reported; the opening click hangs 30 s",
    // TODO(browser): downloads go to the person's browser and are never reported or published.
    downloads: "downloads are never reported",
    // TODO(browser): no `frames()` for user tabs; snapshots omit every iframe's content.
    frames: "iframe content is missing from snapshots",
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
