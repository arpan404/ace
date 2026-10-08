import type { Page } from "@playwright/test";
import { checkBudgets, retryTiming } from "@ace/perf-kit";
import { z } from "zod";
import { budgets } from "./budgets.ts";
import { observe, readRecord, report, resetRecord } from "./measure.ts";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * One long answer streaming in a real browser (ADR 0056): the production build in `--mode perf`
 * with `?markdown=1`, whose client worker streams a ~40 KB markdown answer (sections of prose,
 * nested and task lists, fenced code and a table) in 20-character deltas while a person types
 * into the composer. Input to next paint and long tasks must stay within budget, the markdown
 * worker's time per update must not grow with the answer, and finished blocks must keep their
 * DOM nodes.
 */

const limits = budgets.markdownStream;
const seconds = Number(process.env.PERF_SECONDS ?? limits.seconds);

/** Init script: frames drawn, and markdown blocks whose DOM node was replaced (a remount). */
const probe = () => {
  const counts = { frames: 0, remounts: 0 };
  const tick = () => {
    counts.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new MutationObserver((records) => {
    for (const record of records) {
      // A block is a child of the markdown root, which is a child of the answer.
      const root = record.target;
      if (!(root instanceof Element) || !root.parentElement?.classList.contains("group/answer"))
        continue;
      for (const node of record.removedNodes) if (node instanceof Element) counts.remounts++;
    }
  }).observe(document, { childList: true, subtree: true });
  Object.assign(globalThis, { aceStreamProbe: counts });
};

const Probe = z.object({ frames: z.number(), remounts: z.number() });
const Update = z.object({ stream: z.string(), chars: z.number(), ms: z.number() });
const readProbe = async (page: Page) =>
  Probe.parse(await page.evaluate(() => Reflect.get(globalThis, "aceStreamProbe")));
const readUpdates = async (page: Page) =>
  z
    .array(Update)
    .parse(await page.evaluate(() => Reflect.get(globalThis, "acePerf")?.markdown ?? []));

const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const quantile = (values: readonly number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;

/** One line of the report; a broken budget is added to `into`. */
function line(label: string, value: number, limit: number | string, ok: boolean, into?: string[]) {
  if (!report(label, value, limit, ok)) into?.push(`${label}: ${value} (budget ${limit})`);
}

async function measureStream(): Promise<void> {
  await withPerfApp(async ({ browser, origin }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(observe);
    await page.addInitScript(probe);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const busy = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return (metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0) * 1000;
    };
    await open(page, `${origin}/t/thread-soak?markdown=1&rate=${limits.eventsPerSecond}`);
    const feed = page.getByRole("feed", { name: "Transcript" });
    await feed.waitFor({ timeout: 30_000 });
    const composer = page.locator("textarea").first();
    await composer.waitFor();
    const startUpdates = (await readUpdates(page)).length;
    const startProbe = await readProbe(page);
    const startBusy = await busy();
    const start = await resetRecord(page);
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await composer.click();
      await page.keyboard.type("check the replay window ", { delay: 30 });
      await feed.hover();
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(100);
      await page.mouse.wheel(0, 4_000);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    }
    const result = await readRecord(page, start);
    const busyMs = (await busy()) - startBusy;
    const endProbe = await readProbe(page);
    const updates = (await readUpdates(page)).slice(startUpdates);
    await page.close();

    // The first answer of the window, from its first update to its last.
    const first = updates[0]?.stream;
    const answer = updates.filter((update) => update.stream === first);
    const chars = Math.max(0, ...answer.map((update) => update.chars));
    const early = answer.filter((update) => update.chars <= chars / 4).map((u) => u.ms);
    const late = answer.filter((update) => update.chars >= (chars * 3) / 4).map((u) => u.ms);
    const growth = median(late) / Math.max(median(early), limits.workerFloorMs);
    const frames = endProbe.frames - startProbe.frames;
    const remounts = endProbe.remounts - startProbe.remounts;

    const resources: string[] = [];
    const timing: string[] = [];
    line(
      "answer streamed (KB)",
      chars / 1024,
      `≥ ${limits.answerKb}`,
      chars / 1024 >= limits.answerKb,
      resources,
    );
    line("markdown updates", answer.length, "report", true);
    line("worker ms per update, median", median(answer.map((u) => u.ms)), "report", true);
    line(
      "worker ms per update, p95",
      quantile(
        answer.map((u) => u.ms),
        0.95,
      ),
      "report",
      true,
    );
    line("worker ms per update, first quarter (median)", median(early), "report", true);
    line("worker ms per update, last quarter (median)", median(late), "report", true);
    line(
      "worker time growth, last over first quarter",
      growth,
      limits.workerGrowth,
      growth <= limits.workerGrowth,
      timing,
    );
    line(
      `main-thread ms per frame (${frames} frames)`,
      busyMs / Math.max(1, frames),
      limits.mainMsPerFrame,
      busyMs / Math.max(1, frames) <= limits.mainMsPerFrame,
      timing,
    );
    line("block remounts", remounts, limits.remounts, remounts <= limits.remounts, resources);
    line(
      `interaction p95 (ms, ${result.interactions} interactions)`,
      result.p95,
      limits.interactionP95Ms,
      result.p95 <= limits.interactionP95Ms,
      timing,
    );
    line(
      `longest main-thread task (ms, ${result.longCount} over 50)`,
      result.longest,
      limits.longestTaskMs,
      result.longest <= limits.longestTaskMs,
      timing,
    );
    checkBudgets(resources, timing);
  });
}

await retryTiming(measureStream, (error) => {
  process.stderr.write(
    `${error.message}; repeating the complete streaming workload once with unchanged budgets\n`,
  );
});
