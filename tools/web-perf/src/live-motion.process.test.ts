import type { Page } from "@playwright/test";
import { inject, test, expect } from "vitest";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * The production build (`vite build`, served by `vite preview`) with a live agent streaming: once
 * the app is connected, its live indicators are on screen and hold still. Nothing loops forever
 * (styles/motion.css): an infinite animation keeps the compositor drawing frames for as long as
 * the agent works, which is idle CPU on the GPU and renderer. Only the startup mark's breath and
 * an indeterminate progress bar may repeat. This is what the installed desktop app ships, so a
 * stylesheet or component that brings back a perpetual animation fails here.
 */

/** The live indicators on screen and every animation on the page that repeats forever. */
async function liveMotion(page: Page) {
  return page.evaluate(() => {
    const live = document.querySelectorAll(
      '[data-slot="status-glyph"][data-live], [data-slot="spinner"], [aria-label="Streaming"]',
    );
    const looping = document.getAnimations().flatMap((animation) => {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || animation.playState !== "running") return [];
      if (effect.getComputedTiming().iterations !== Infinity) return [];
      const target = effect.target;
      if (target?.closest(".fx-breathe, .fx-indeterminate")) return [];
      const name = animation instanceof CSSAnimation ? animation.animationName : animation.id;
      return [`${target?.getAttribute("class") ?? target?.tagName ?? "?"}: ${name}`];
    });
    return {
      connection: document.querySelector("[data-connection]")?.getAttribute("data-connection"),
      reduced: document.documentElement.hasAttribute("data-reduce-motion"),
      live: [...live].map((element) => element.getAttribute("data-state") ?? element.tagName),
      looping,
    };
  });
}

/** Waits until the shell is connected and the agent's working glyph is on screen. */
async function connectedWithIndicators(page: Page) {
  for (let attempt = 0; ; attempt++) {
    const seen = await liveMotion(page);
    if (seen.connection === "ready" && seen.live.includes("working")) return seen;
    if (attempt > 240)
      throw new Error(`No live indicator once connected: ${JSON.stringify(seen).slice(0, 2000)}`);
    await page.waitForTimeout(250);
  }
}

test("while an agent works its live indicators show and nothing loops forever, with and without Reduce motion", async () => {
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
          expect(seen.looping).toEqual([]);
          // Still true a while later, as events keep arriving and rows mount.
          await page.waitForTimeout(2_000);
          expect((await liveMotion(page)).looping).toEqual([]);
        } finally {
          await context.close();
        }
      }
    },
    [],
    inject("chromiumExecutable"),
  );
});
