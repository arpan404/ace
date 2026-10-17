import { z } from "zod";
import type { BrowserBackendPage } from "./backend.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import { chromeInput } from "./chrome-input.ts";
import type { EmbeddedTabs } from "./embedded-tabs.ts";
import { modelScreenshot } from "./model-screenshot.ts";

/**
 * One desktop tab's page, driven through that tab's own CDP relay. The shown tab keeps the
 * desktop's native key presses and view sizing; a background tab uses CDP key events and
 * cannot be resized (its view has no place on screen).
 */
export function embeddedTabPage(
  tabs: EmbeddedTabs,
  id: string,
  shown: {
    press(key: string): Promise<unknown>;
    resize(width: number, height: number): Promise<unknown>;
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
    frames: () => tabs.frames(id),
    url: () => tabs.list().find((tab) => tab.tabId === id)?.url ?? "about:blank",
    navigate: async (url, _timeout, signal) => {
      await navigateCdp(cdp(), url, signal ?? new AbortController().signal);
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
      if (!isShown()) throw new Error("Only the shown desktop tab can be resized");
      await shown.resize(width, height);
    },
    viewport: () => tabs.tab(id).viewport,
    media: async (colorScheme) => {
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    },
  };
}
