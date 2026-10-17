import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { z } from "zod";
import type { ConformanceScenario } from "./engine.ts";
import { eventually, pngSize, tabs } from "./scenario-support.ts";

export const navigationScenarios: ConformanceScenario[] = [
  {
    id: "navigate",
    title: "navigating loads the page and reports its URL and title",
    async run(page) {
      const url = `${page.site.origin}/`;
      const state = z
        .object({ url: z.string() })
        .parse(await page.execute({ action: "navigate", url }));
      expect(state.url).toBe(url);
      expect(await page.evaluate("document.querySelector('h1').textContent")).toBe("Home page");
      await eventually(async () => {
        const list = await tabs(page);
        expect(list.tabs.find((tab) => tab.tabId === list.activeTabId)).toMatchObject({
          url,
          title: "Conformance home",
        });
      });
    },
  },
  {
    id: "redirects",
    title: "a chain of redirects ends on the final page and reports its URL",
    async run(page) {
      const state = z
        .object({ url: z.string() })
        .parse(await page.execute({ action: "navigate", url: `${page.site.origin}/redirect/3` }));
      expect(state.url).toBe(`${page.site.origin}/landing`);
      expect(await page.evaluate("document.querySelector('h1').textContent")).toBe(
        "Landed after redirects",
      );
    },
  },
  {
    id: "self-navigation",
    title: "a page that navigates itself right after load still counts as loaded",
    async run(page) {
      await page.execute({ action: "navigate", url: `${page.site.origin}/bounce` });
      await page.execute({ action: "wait_for", text: "Bounced page" });
      await eventually(() =>
        expect(page.service.state(page.threadId).url).toBe(`${page.site.origin}/bounced`),
      );
    },
  },
  {
    id: "screenshot",
    title: "a screenshot is a PNG of the viewport at the page's device pixel ratio",
    async run(page) {
      await page.execute({ action: "navigate", url: `${page.site.origin}/` });
      await page.execute({ action: "resize", width: 900, height: 700 });
      const viewport = z
        .object({ width: z.number(), height: z.number(), ratio: z.number() })
        .parse(
          await page.evaluate(
            "({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio })",
          ),
        );
      expect({ width: viewport.width, height: viewport.height }).toEqual({
        width: 900,
        height: 700,
      });
      const shot = z
        .object({ path: z.string(), mimeType: z.literal("image/png") })
        .parse(await page.execute({ action: "screenshot" }));
      expect(pngSize(await readFile(shot.path))).toEqual({
        width: Math.round(900 * viewport.ratio),
        height: Math.round(700 * viewport.ratio),
      });
    },
  },
  {
    id: "evaluate",
    title: "evaluate returns structured values, awaits promises and reports page exceptions",
    async run(page) {
      await page.execute({ action: "navigate", url: `${page.site.origin}/` });
      expect(await page.evaluate("({ sum: 1 + 2, list: [document.title, null] })")).toEqual({
        sum: 3,
        list: ["Conformance home", null],
      });
      expect(
        await page.evaluate("new Promise((done) => setTimeout(() => done('later'), 20))"),
      ).toBe("later");
      await expect(page.evaluate("(() => { throw new Error('page-boom') })()")).rejects.toThrow();
    },
  },
];
