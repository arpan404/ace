import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, inject, test } from "vitest";
import { withDeckFlow } from "./deck-flow.ts";

/*
 * The Deck end to end (docs/editor/workbench.md 9, 13, 46, 52), on a real daemon and ace-files
 * over a temporary checkout: a file the agent mentions in the chat opens as a preview tab in the
 * thread's Deck while the chat keeps the keyboard; a reload brings the layout back; and a write
 * to the open file under unsaved edits raises the notice, whose Merge keeps both changes.
 */

const path = "notes/plan.ts";
const reply = `Start with [plan.ts](${path}).`;

test(
  "a mentioned file opens in the Deck beside the chat, survives a reload, and merges a write under unsaved edits",
  async () => {
    await withDeckFlow(
      { files: { [path]: "one\ntwo\nthree\nfour\n" }, reply },
      async ({ origin, daemon, threadId, checkout }) => {
        const browser = await chromium.launch({ executablePath: inject("chromiumExecutable") });
        try {
          const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
          await page.addInitScript((target) => {
            if (sessionStorage.getItem("ace.deck-flow.seeded")) return;
            sessionStorage.setItem("ace.deck-flow.seeded", "1");
            localStorage.setItem("ace.daemon.url", target.url);
            localStorage.setItem("ace.daemon.token", target.token);
          }, daemon);
          await page.goto(`${origin}/t/${threadId}`);

          // The agent's reply links the file; the composer has the keyboard.
          const link = page.getByRole("link", { name: "plan.ts", exact: true });
          await link.waitFor({ timeout: 60_000 });
          const composer = page.getByRole("combobox", { name: "Message" });
          await composer.focus();
          await link.click();
          const deck = page.locator('[data-part="deck-panel"]');
          const tab = deck.locator(`[role="tab"][data-path="${path}"]`);
          await tab.waitFor({ timeout: 30_000 });
          expect(await tab.getAttribute("data-preview")).toBe("");
          await deck
            .getByRole("region", { name: `Source of ${path}` })
            .waitFor({ timeout: 30_000 });
          // A glance by pointer leaves the keyboard in the chat.
          expect(await deck.evaluate((panel) => panel.contains(document.activeElement))).toBe(
            false,
          );

          // Reload: the Deck comes back with the file shown.
          await page.reload();
          await tab.waitFor({ timeout: 30_000 });
          const source = deck.getByRole("region", { name: `Source of ${path}` });
          await source.waitFor({ timeout: 30_000 });

          // Unsaved edits at the top, then an agent-style write at the bottom.
          await deck.getByRole("textbox", { name: "plan.ts" }).focus();
          await page.keyboard.type("mine ");
          await expect.poll(() => tab.getAttribute("data-preview")).toBeNull();
          await writeFile(join(checkout, path), "one\ntwo\nthree\nfour\nagent\n");
          const notice = deck.locator('[data-part="deck-notice"]');
          await notice.waitFor({ timeout: 30_000 });
          await notice.getByRole("button", { name: "Merge" }).click();
          await notice.waitFor({ state: "detached", timeout: 30_000 });
          await expect.poll(() => source.textContent()).toContain("mine one");
          expect(await source.textContent()).toContain("agent");
          // Merged, not saved: the disk still has only the agent's change.
          expect(await readFile(join(checkout, path), "utf8")).toBe(
            "one\ntwo\nthree\nfour\nagent\n",
          );
        } finally {
          await browser.close();
        }
      },
    );
  },
  10 * 60_000,
);
