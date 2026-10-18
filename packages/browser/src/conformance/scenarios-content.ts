import { expect } from "vitest";
import { z } from "zod";
import type { ConformancePage, ConformanceScenario } from "./engine.ts";
import { eventually, ref, visit } from "./scenario-support.ts";

/** The tab the scenario works in, as the person's clients see it. */
function shownTab(page: ConformancePage) {
  const state = page.service.state(page.threadId);
  return state.tabs?.find((tab) => tab.tabId === state.activeTabId);
}

async function follow(page: ConformancePage, link: string) {
  await visit(page, "/files", "Files page");
  await page.execute({
    action: "click",
    ref: ref(await page.execute({ action: "snapshot" }), link),
  });
}

const Downloads = z.object({ downloads: z.array(z.object({ filename: z.string() })) });

/** What a tab shows for files that are not pages, and for files it cannot show. */
export const contentScenarios: ConformanceScenario[] = [
  {
    id: "page-identity",
    title: "the tab's title and favicon follow the page, including a title the page changes",
    async run(page) {
      await visit(page, "/identity", "Identity ready");
      await eventually(() => {
        const tab = shownTab(page);
        expect(tab?.title).toBe("Identity page");
        expect(tab?.favicon).toMatch(/^data:image\/png;base64,/);
      });
      await page.execute({
        action: "click",
        ref: ref(await page.execute({ action: "snapshot" }), "Rename"),
      });
      await eventually(() => expect(shownTab(page)?.title).toBe("Renamed (1)"));
      // A page without an icon of its own drops the last page's.
      await visit(page, "/landing", "Landed");
      await eventually(() => {
        expect(shownTab(page)?.title).toBe("Landing");
        expect(shownTab(page)?.favicon).toBeUndefined();
      });
    },
  },
  {
    id: "pdf-inline",
    title: "a PDF link opens in the tab instead of downloading",
    async run(page) {
      await follow(page, "Open PDF");
      await eventually(() => expect(shownTab(page)?.url).toMatch(/\/files\/doc\.pdf$/));
      await eventually(async () =>
        expect(await page.evaluate("document.contentType")).toBe("application/pdf"),
      );
      expect(Downloads.parse(await page.execute({ action: "downloads" })).downloads).toEqual([]);
    },
  },
  {
    id: "image-inline",
    title: "an image URL opens in the tab",
    async run(page) {
      await follow(page, "Open image");
      await eventually(() => expect(shownTab(page)?.url).toMatch(/\/files\/photo\.png$/));
      await eventually(async () =>
        expect(
          await page.evaluate("[document.contentType, document.images[0]?.naturalWidth]"),
        ).toEqual(["image/png", 40]),
      );
    },
  },
  {
    id: "zip-download",
    title: "a zip link becomes a download and the page stays where it was",
    async run(page) {
      // An engine that cannot see downloads says so here, before anything waits for one.
      expect(Downloads.parse(await page.execute({ action: "downloads" })).downloads).toEqual([]);
      await follow(page, "Get archive");
      await eventually(() => {
        expect(page.artifacts.map((artifact) => artifact.filename)).toContain("archive.zip");
      }, 30_000);
      expect(Downloads.parse(await page.execute({ action: "downloads" })).downloads).toContainEqual(
        expect.objectContaining({ filename: "archive.zip" }),
      );
      expect(shownTab(page)?.url).toMatch(/\/files$/);
      expect(await page.evaluate("document.contentType")).toBe("text/html");
    },
  },
];
