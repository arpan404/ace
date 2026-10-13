import type { Page } from "@playwright/test";
import { inject, test, expect } from "vitest";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * The production build (`vite build`, served by `vite preview`) with a live agent streaming:
 * once the app is connected, its live indicators really animate. This is what the installed
 * desktop app ships, so a stylesheet or shell rule that stops or pauses them fails here.
 */

/** Every live indicator on the page and the state of its running animation. */
async function liveIndicators(page: Page) {
  return page.evaluate(() => {
    const live = document.querySelectorAll(
      ".spin-ring, .fx-spin-slow, .fx-walk > [data-step], .fx-breathe, .fx-indeterminate",
    );
    return {
      connection: document.querySelector("[data-connection]")?.getAttribute("data-connection"),
      reduced: document.documentElement.hasAttribute("data-reduce-motion"),
      indicators: [...live].map((element) => ({
        className: element.getAttribute("class"),
        states: element.getAnimations().map((animation) => animation.playState),
      })),
    };
  });
}

/** Waits until the shell is connected and a live indicator is on screen. */
async function connectedWithIndicators(page: Page) {
  for (let attempt = 0; ; attempt++) {
    const seen = await liveIndicators(page);
    if (seen.connection === "ready" && seen.indicators.length > 0) return seen;
    if (attempt > 240)
      throw new Error(`No live indicator once connected: ${JSON.stringify(seen).slice(0, 2000)}`);
    await page.waitForTimeout(250);
  }
}

test("once connected, live indicators animate, with and without the Reduce motion setting", async () => {
  await withPerfApp(
    async ({ origin, browser }) => {
      for (const reduceMotion of ["system", "on"] as const) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        try {
          const page = await context.newPage();
          await page.addInitScript((setting) => {
            localStorage.setItem("ace.appearance", JSON.stringify({ reduceMotion: setting }));
          }, reduceMotion);
          await open(page, `${origin}/t/thread-soak?rate=20`);
          const seen = await connectedWithIndicators(page);
          expect(seen.reduced).toBe(reduceMotion === "on");
          const stopped = seen.indicators.filter(
            (indicator) =>
              indicator.states.length === 0 ||
              indicator.states.some((state) => state !== "running"),
          );
          expect(stopped).toEqual([]);
        } finally {
          await context.close();
        }
      }
    },
    [],
    inject("chromiumExecutable"),
  );
});
