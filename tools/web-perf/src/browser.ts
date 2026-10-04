import { budgets } from "./budgets.ts";
import { observe, readRecord, report, resetRecord } from "./measure.ts";
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

let failed = false;
await withPerfApp(port, async ({ browser, origin }) => {
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(observe);
    await open(page, `${origin}/t/thread-soak?rate=${rate}`);
    await page.getByRole("feed", { name: "Transcript" }).waitFor({ timeout: 30_000 });
    const composer = page.locator("textarea").first();
    await composer.waitFor();
    // Warm up: the stream starts a second after attach; let it reach speed.
    await page.waitForTimeout(3_000);
    // The detector must see a deliberate 120 ms task, or its zero would mean nothing.
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
    const detected = await page.evaluate(() =>
      Reflect.get(globalThis, "acePerfRecord").longTasks.some((value: number) => value >= 100),
    );
    if (!detected) throw new Error("The long-task detector did not see a 120 ms task");
    const startEvents = await page.evaluate(() => Reflect.get(globalThis, "acePerf")?.events ?? 0);
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
    const streamed =
      ((await page.evaluate(() => Reflect.get(globalThis, "acePerf")?.events ?? 0)) - startEvents) /
      result.seconds;
    const lines = [
      [`events/s streamed`, streamed, rate, streamed >= rate * 0.9],
      [
        `interaction p95 (ms, ${result.interactions} interactions)`,
        result.p95,
        budgets.browser.interactionP95Ms,
        result.p95 <= budgets.browser.interactionP95Ms,
      ],
      [`interaction p75 (ms)`, result.p75, budgets.browser.interactionP95Ms, true],
      [
        `longest main-thread task (ms)`,
        result.longest,
        budgets.browser.longestTaskMs,
        result.longest <= budgets.browser.longestTaskMs,
      ],
      [
        `time in long tasks (${result.longCount} tasks)`,
        result.longShare,
        budgets.browser.longTaskShare,
        result.longShare <= budgets.browser.longTaskShare,
      ],
    ] as const;
    for (const [label, value, limit, ok] of lines)
      if (!report(label, value, limit, ok)) failed = true;
    process.stdout.write(`  typed ${typed} characters while streaming\n`);
  }
});
if (failed) {
  process.stderr.write("browser performance budgets exceeded\n");
  process.exit(1);
}
