import { expect } from "vitest";
import { z } from "zod";
import type { ConformanceScenario } from "./engine.ts";
import { eventually, ref, tabs, visit } from "./scenario-support.ts";

const Opened = z.object({ tabId: z.string() });

export const tabScenarios: ConformanceScenario[] = [
  {
    id: "tabs",
    title: "tabs open, select and close, and commands on each tab act on that tab only",
    async run(page) {
      const { origin } = page.site;
      const first = (await tabs(page)).activeTabId;
      await visit(page, "/form", "Save", first);
      const second = Opened.parse(
        await page.execute({ action: "tabs", operation: "open", url: `${origin}/landing` }),
      ).tabId;
      expect(second).not.toBe(first);
      await page.execute({ action: "wait_for", text: "Landed", tabId: second });
      // Both tabs answer at once, each about its own document.
      expect(
        await Promise.all([
          page.evaluate("location.pathname", first),
          page.evaluate("location.pathname", second),
        ]),
      ).toEqual(["/form", "/landing"]);
      const snapshot = await page.execute({ action: "snapshot", tabId: first });
      await page.execute({ action: "type", tabId: first, ref: ref(snapshot, "Name"), text: "one" });
      expect(await page.evaluate("document.querySelector('input')?.value ?? 'none'", second)).toBe(
        "none",
      );
      await page.execute({ action: "tabs", operation: "select", tabId: second });
      await eventually(() => expect(page.service.state(page.threadId).activeTabId).toBe(second));
      await page.execute({ action: "tabs", operation: "close", tabId: second });
      await eventually(async () =>
        expect((await tabs(page)).tabs.map((tab) => tab.tabId)).toEqual([first]),
      );
      expect(await page.evaluate("document.querySelector('input').value", first)).toBe("one");
    },
  },
  {
    id: "tab-ids",
    title: "a tab keeps its id through navigations and while other tabs open and close",
    async run(page) {
      const { origin } = page.site;
      const first = (await tabs(page)).activeTabId;
      await page.execute({ action: "navigate", url: `${origin}/`, tabId: first });
      const second = Opened.parse(
        await page.execute({ action: "tabs", operation: "open", url: `${origin}/landing` }),
      ).tabId;
      await page.execute({ action: "navigate", url: `${origin}/form`, tabId: first });
      const third = Opened.parse(
        await page.execute({ action: "tabs", operation: "open", url: `${origin}/` }),
      ).tabId;
      await page.execute({ action: "tabs", operation: "close", tabId: second });
      await eventually(async () => {
        const list = await tabs(page);
        expect(list.tabs.map((tab) => tab.tabId)).toEqual([first, third]);
        expect(list.tabs.find((tab) => tab.tabId === first)?.url).toBe(`${origin}/form`);
      });
      expect(new Set([first, second, third]).size).toBe(3);
    },
  },
  {
    id: "popups",
    title: "a page's target=_blank link opens a page the agent can reach",
    async run(page) {
      await visit(page, "/popup", "Opener");
      const before = (await tabs(page)).tabs.length;
      await page.execute({
        action: "click",
        ref: ref(await page.execute({ action: "snapshot" }), "Open popup"),
      });
      // Engines may follow the popup in the opener's tab or add a tab; either way it is reachable.
      const target = `${page.site.origin}/popup-target`;
      const reached = await eventually(async () => {
        const found = (await tabs(page)).tabs.find((tab) => tab.url === target);
        expect(found).toBeDefined();
        return found?.tabId ?? "";
      });
      await page.execute({ action: "wait_for", text: "Popup page", tabId: reached });
      expect((await tabs(page)).tabs.length).toBeLessThanOrEqual(before + 1);
    },
  },
];
