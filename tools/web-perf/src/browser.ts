import { budgets } from "./budgets.ts";
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

const observe = () => {
  const record = { longTasks: [] as number[], events: new Map<number, number>(), start: 0 };
  Object.assign(globalThis, { acePerfRecord: record });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) record.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const id =
        "interactionId" in entry && typeof entry.interactionId === "number"
          ? entry.interactionId
          : 0;
      if (!id) continue;
      record.events.set(id, Math.max(record.events.get(id) ?? 0, entry.duration));
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
};

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
    const before = await page.evaluate(() => {
      const record = Reflect.get(globalThis, "acePerfRecord");
      record.longTasks.length = 0;
      record.events.clear();
      return { events: Reflect.get(globalThis, "acePerf")?.events ?? 0, at: performance.now() };
    });
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
    const result = await page.evaluate((start) => {
      const record = Reflect.get(globalThis, "acePerfRecord");
      const elapsed = (performance.now() - start.at) / 1000;
      const durations = [...record.events.values()].toSorted((a: number, b: number) => a - b);
      const at = (q: number) =>
        durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] ?? 0;
      const longTasks: number[] = record.longTasks;
      return {
        rate: ((Reflect.get(globalThis, "acePerf")?.events ?? 0) - start.events) / elapsed,
        interactions: durations.length,
        p75: at(0.75),
        p95: at(0.95),
        longest: Math.max(0, ...longTasks),
        longShare: longTasks.reduce((sum, value) => sum + value, 0) / (elapsed * 1000),
        longCount: longTasks.length,
      };
    }, before);
    const lines = [
      [`events/s streamed`, result.rate, rate, result.rate >= rate * 0.9],
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
    for (const [label, value, limit, ok] of lines) {
      process.stdout.write(
        `${ok ? " " : "✗"} ${label.padEnd(48)} ${value.toFixed(2).padStart(9)}  (budget ${limit})\n`,
      );
      if (!ok) failed = true;
    }
    process.stdout.write(`  typed ${typed} characters while streaming\n`);
  }
});
if (failed) {
  process.stderr.write("browser performance budgets exceeded\n");
  process.exit(1);
}
