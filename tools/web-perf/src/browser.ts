import { budgets } from "./budgets.ts";
import { retryTiming } from "@ace/perf-kit";
import { reportBrowser } from "./browser-budgets.ts";
import { observe, readRecord, resetRecord, streamedRate } from "./measure.ts";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * Main-thread budgets in a real browser (ADR 0056): the production build in `--mode perf`,
 * whose client worker streams an endless agent at 5,000 events/s, while a person types into
 * the composer and scrolls the transcript. Long tasks and Event Timing entries are recorded
 * from first paint; interaction latency is input to next paint per interaction.
 */

const port = 5_197;
const seconds = Number(process.env.PERF_SECONDS ?? 12);
const rate = budgets.browser.eventsPerSecond;

async function measureBrowser(): Promise<void> {
  await withPerfApp(port, async ({ browser, origin }) => {
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(observe);
      // The source needs headroom over the floor: timer batches cannot land exactly
      // on both ends of the page's measurement window. This increases the workload.
      await open(page, `${origin}/t/thread-soak?rate=${Math.ceil(rate * 1.01)}`);
      await page.getByRole("feed", { name: "Transcript" }).waitFor({ timeout: 30_000 });
      const firstPaint = await page.evaluate(
        () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      );
      if (typeof firstPaint !== "number")
        throw new Error("First contentful paint was not recorded");
      process.stdout.write(`  first contentful paint (ms) ${firstPaint.toFixed(2)}\n`);
      const composer = page.locator("textarea").first();
      await composer.waitFor();
      // Warm up: the stream starts a second after attach; let it reach speed.
      await page.waitForTimeout(3_000);
      // The detector must see a deliberate 120 ms task, or its zero would mean nothing.
      const detectorStart = await resetRecord(page);
      await page.evaluate(() => {
        // A page task, not the evaluation itself, which the browser does not attribute.
        setTimeout(() => {
          const end = performance.now() + 120;
          while (performance.now() < end) {
            /* block the main thread */
          }
        }, 0);
      });
      await page.waitForTimeout(500);
      if ((await readRecord(page, detectorStart)).longest < 100)
        throw new Error(
          "The long-task detector did not see a 120 ms task after resetting its window",
        );
      const start = await resetRecord(page);
      const feed = page.getByRole("feed", { name: "Transcript" });
      const until = Date.now() + seconds * 1000;
      let typed = 0;
      while (Date.now() < until) {
        await composer.click();
        await page.keyboard.type("check the replay window ", { delay: 30 });
        typed += 24;
        await feed.hover();
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(150);
        await page.mouse.wheel(0, 400);
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.press("Backspace");
      }
      const result = await readRecord(page, start);
      const streamed = streamedRate(result);
      process.stdout.write(`  typed ${typed} characters while streaming\n`);
      reportBrowser(streamed, result);
    }
  });
}
await retryTiming(measureBrowser, (error) => {
  process.stderr.write(
    `${error.message}; repeating the complete browser workload once with unchanged budgets\n`,
  );
});
