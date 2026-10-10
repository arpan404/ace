import { expect as browserExpect } from "@playwright/test";
import { inject, test } from "vitest";
import { open, withPerfApp } from "./perf-app.ts";
import { scrollTranscript, selectTurn, stepTurn } from "@ace/web-perf";

test.each([false, true])(
  "search brings a tool-output hit into the real transcript after historical navigation=%s",
  async (historical) => {
    await withPerfApp(
      async ({ origin, browser }) => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await open(page, `${origin}/t/thread-multi-day?long=1&rate=20`);
        const feed = page.getByRole("feed", { name: "Transcript" });
        await feed.waitFor();
        await page.getByRole("combobox", { name: "Message" }).waitFor();
        await browserExpect(page.getByRole("region", { name: "While you were away" })).toHaveCount(
          0,
        );
        await browserExpect(
          page.getByRole("button", { name: "Summarise", exact: true }),
        ).toHaveCount(0);
        if (historical) {
          // Turns lives in the header's ⋯ menu.
          await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
          await page.getByRole("menuitem", { name: /^Turns/ }).click();
          await selectTurn(page, 137);
          await page.keyboard.press("Enter");
          await feed.getByText("Migrate checkpoint 137, inspect files").first().waitFor();
          await page.keyboard.press("Escape");
          for (let step = 0; step < 8; step++) await scrollTranscript(page, 900, 120);
          for (let step = 0; step < 4; step++) await scrollTranscript(page, -700, 120);
          const mod = process.platform === "darwin" ? "Meta" : "Control";
          await stepTurn(page, `Alt+${mod}+ArrowDown`);
          await stepTurn(page, `Alt+${mod}+ArrowUp`);
        }
        // Search this thread lives in the header's ⋯ menu (⌘F also opens it).
        await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
        await page.getByRole("menuitem", { name: /^Search this thread/ }).click();
        const bar = page.getByRole("search", { name: "Search this thread" });
        await bar.getByRole("textbox").fill("checkpoint scan output");
        await bar.getByRole("option").first().waitFor();
        for (let hit = 1; hit <= 3; hit++) {
          await page.keyboard.press("Enter");
          await browserExpect(bar.locator("[aria-live]")).toHaveText(new RegExp(`^${hit} of `));
          await browserExpect(feed.locator("[data-hit]")).toBeVisible();
          await browserExpect(feed.locator("[data-hit]")).toBeInViewport();
        }
        await bar.getByRole("button", { name: "Errors", exact: true }).click();
        await browserExpect(bar.locator("[aria-live]")).toHaveText(/^(No results|None yet)$/);
        await browserExpect(bar.getByRole("listbox", { name: "Results" })).toBeAttached();
        await browserExpect(bar.getByText(/^Nothing /)).toBeVisible();
      },
      [],
      inject("chromiumExecutable"),
    );
  },
);
