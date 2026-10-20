import { z } from "zod";
import type { BrowserBackendPage, VideoHost } from "./backend.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { chromeInput } from "./chrome-input.ts";
import type { EmbeddedTabs } from "./embedded-tabs.ts";
import { modelScreenshot } from "./model-screenshot.ts";

/**
 * One desktop tab's page, driven through that tab's own CDP relay. The shown tab keeps the
 * desktop's native key presses and the panel's size; a background tab uses CDP key events and
 * is sized with `ace.tabs.resize` (its view has no place on screen).
 */
export function embeddedTabPage(
  tabs: EmbeddedTabs,
  id: string,
  shown: {
    press(key: string): Promise<unknown>;
    resize(width: number, height: number): Promise<unknown>;
    /** The desktop's video encoder for this tab, when it has one (ADR 0088). */
    video?: () => VideoHost;
  },
): BrowserBackendPage {
  const cdp = () => tabs.tab(id).cdp;
  const input = chromeInput(cdp, process.platform);
  const isShown = () => tabs.active() === id;
  return {
    get cdp() {
      return cdp();
    },
    findText: (text, forward) => cdp().send("ace.findText", { text, forward }),
    pageStatus: () => tabs.pageStatus(id) ?? { loading: false },
    networkBody: (requestId) => tabs.inspection.body(requestId),
    networkPending: () => tabs.inspection.pending(id),
    frames: () => tabs.frames(id),
    url: () => tabs.list().find((tab) => tab.tabId === id)?.url ?? "about:blank",
    crashed: () => tabs.crashed(id),
    navigate: async (url, _timeout, signal) => {
      const navigation = signal ?? new AbortController().signal;
      // A tab whose renderer the desktop stopped reloading comes back before it navigates.
      await tabs.revive(id, navigation);
      await navigateCdp(cdp(), url, navigation);
    },
    click: (x, y) => input.click(x, y),
    insertText: (text) => input.insertText(text),
    press: async (key) => {
      if (isShown()) await shown.press(key);
      else await input.press(key);
    },
    wheel: (x, y) => input.wheel(x, y),
    screenshot: async (format) => {
      if (format === "jpeg") return modelScreenshot(cdp());
      const result = z
        .object({ data: z.string().max(768 * 1024) })
        .parse(await cdp().send("Page.captureScreenshot", { format }));
      return Buffer.from(result.data, "base64");
    },
    resize: async (width, height) => {
      if (isShown()) await shown.resize(width, height);
      else await tabs.resize(id, width, height);
    },
    viewport: () => tabs.tab(id).viewport,
    ...(shown.video ? { video: shown.video } : {}),
    // The desktop applies these to the view itself: native zoom, and its partition's data.
    zoom: async (factor) => {
      await cdp().send("ace.zoom", { factor });
    },
    clearData: async () => {
      await cdp().send("ace.clearData");
    },
    media: async (colorScheme) => {
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    },
  };
}
