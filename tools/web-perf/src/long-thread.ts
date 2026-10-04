import type { Page } from "@playwright/test";
import { budgets } from "./budgets.ts";
import { observe, pageMemory, readRecord, report, resetRecord } from "./measure.ts";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * A million-item thread in a real browser (ADR 0056, ADR 0062): the production build in
 * `--mode perf` with `?long=1`, whose client worker serves the synthetic five-day thread
 * (`multiDayThread`: 1,000,000 items, 2,000 turns, 48 subagent threads) on demand while a live
 * turn keeps adding items. Each round a person opens the turn timeline and jumps across days,
 * scrolls the jumped window toward the present, steps between turns, searches the thread and
 * steps through hits, then jumps back to live. Input to next paint, long tasks, the DOM and the
 * page's retained heap must stay within budget.
 */

const port = 5_199;
const limits = budgets.longThread;
const mod = process.platform === "darwin" ? "Meta" : "Control";
/** Turns each round jumps to: days apart, old and recent. */
const targets = [137, 1_777, 412, 1_503, 64, 1_024, 1_960, 750];
/** Searches each round: words in every turn, error notices, a file, an early turn's output. */
const queries = [
  "checkpoint scan output",
  "retryable scan error",
  "src/module-42.ts",
  "tool-output-needle-3",
  "verified migration",
  "examined dependency",
];
const turnCount = 2_000;

/** Moves the timeline's selection to `target` from whichever end is nearer, as keys. */
async function selectTurn(page: Page, target: number): Promise<void> {
  await page.keyboard.press(target > turnCount / 2 ? "End" : "Home");
  // The live turn may have joined the list: read where the selection landed.
  const list = page.getByRole("listbox", { name: "Turns of this thread" });
  let at = Number((await list.getAttribute("aria-activedescendant"))?.replace("turn-option-", ""));
  while (Math.abs(target - at) >= 10) {
    await page.keyboard.press(target > at ? "PageDown" : "PageUp");
    at += target > at ? 10 : -10;
  }
  while (at !== target) {
    await page.keyboard.press(target > at ? "ArrowDown" : "ArrowUp");
    at += target > at ? 1 : -1;
  }
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function since(page: Page, start: number): Promise<number> {
  return (await page.evaluate(() => performance.now())) - start;
}

let failed = false;
await withPerfApp(port, async ({ browser, origin }) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(observe);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await open(page, `${origin}/t/thread-multi-day?long=1&rate=${limits.liveRate}`);
  const feed = page.getByRole("feed", { name: "Transcript" });
  await feed.waitFor({ timeout: 30_000 });
  await page.locator("textarea").first().waitFor();
  const ready = await page.evaluate(() => performance.now());
  // The perf device last read the thread five turns ago: the catch-up card says what changed.
  const catchUp = page.getByRole("region", { name: "While you were away" });
  await catchUp.waitFor({ timeout: 15_000 });
  const caughtUp = await since(page, 0);
  await catchUp.getByRole("button", { name: "Dismiss" }).click();

  const jumps: number[] = [];
  const searches: number[] = [];
  const nodes: number[] = [];
  const start = await resetRecord(page);
  let warm: number | undefined;
  for (let round = 0; round < limits.rounds; round++) {
    const target = targets[round % targets.length] ?? 1;
    // The timeline: across days to one turn.
    await page.getByRole("button", { name: "Turns" }).click();
    await page.getByRole("listbox", { name: "Turns of this thread" }).waitFor();
    await selectTurn(page, target);
    const jumpAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("Enter");
    await page.getByRole("status", { name: "Jumped" }).waitFor();
    await feed.getByText(`Migrate checkpoint ${target}, inspect files`).first().waitFor();
    jumps.push(await since(page, jumpAt));
    await page.keyboard.press("Escape");
    // Read on toward the present: the window slides, never grows.
    await feed.hover();
    for (let step = 0; step < 8; step++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(120);
    }
    for (let step = 0; step < 4; step++) {
      await page.mouse.wheel(0, -700);
      await page.waitForTimeout(120);
    }
    await page.keyboard.press(`Alt+${mod}+ArrowDown`);
    await page.waitForTimeout(150);
    await page.keyboard.press(`Alt+${mod}+ArrowUp`);
    await page.waitForTimeout(150);
    nodes.push((await pageMemory(cdp)).nodes);
    // Search the thread and step through what it finds.
    await page.keyboard.press(`${mod}+f`);
    const bar = page.getByRole("search", { name: "Search this thread" });
    await bar.waitFor();
    const query = queries[round % queries.length] ?? "checkpoint";
    await page.keyboard.type(query, { delay: 25 });
    const typedAt = await page.evaluate(() => performance.now());
    await bar.getByRole("option").first().waitFor({ timeout: 20_000 });
    searches.push(await since(page, typedAt));
    for (let hit = 0; hit < 3; hit++) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
    }
    await bar.getByRole("button", { name: "Errors" }).click();
    await page.waitForTimeout(300);
    nodes.push((await pageMemory(cdp)).nodes);
    await page.keyboard.press("Escape");
    // Back to the live end, then a look at the live tail.
    await page
      .getByRole("button", { name: /^Jump to live/ })
      .first()
      .click();
    await page.getByRole("status", { name: "Jumped" }).waitFor({ state: "detached" });
    await feed.hover();
    await page.mouse.wheel(0, -1_200);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(400);
    nodes.push((await pageMemory(cdp)).nodes);
    if (round === 0) {
      // Retained heap is measured from a warm state: caches and the JIT have settled once.
      warm = (await pageMemory(cdp)).heapMb;
    }
  }
  const main = await readRecord(page, start);
  const last = await pageMemory(cdp);
  process.stdout.write(`  DOM nodes after jump, search, live per round: ${nodes.join(" ")}\n`);
  const ok = [
    report("transcript and composer usable (ms)", ready, limits.readyMs, ready <= limits.readyMs),
    report("catch-up card shown (ms from navigation)", caughtUp, "-", true),
    report(`jump to a turn, median (ms, ${jumps.length} jumps)`, median(jumps), "-", true),
    report("jump to a turn, slowest (ms)", Math.max(...jumps), "-", true),
    report(`search to first hit, median (ms, ${searches.length})`, median(searches), "-", true),
    report(
      `interaction p95 (ms, ${main.interactions} slow inputs)`,
      main.p95,
      limits.interactionP95Ms,
      main.p95 <= limits.interactionP95Ms,
    ),
    report("interaction p75 (ms)", main.p75, limits.interactionP95Ms, true),
    report(
      "longest main-thread task (ms)",
      main.longest,
      limits.longestTaskMs,
      main.longest <= limits.longestTaskMs,
    ),
    report(
      `time in long tasks (${main.longCount} tasks)`,
      main.longShare,
      limits.longTaskShare,
      main.longShare <= limits.longTaskShare,
    ),
    report(
      "DOM nodes, peak",
      Math.max(...nodes),
      limits.domNodes,
      Math.max(...nodes) <= limits.domNodes,
    ),
    report(
      `retained page heap growth over ${limits.rounds - 1} rounds (MB)`,
      last.heapMb - (warm ?? last.heapMb),
      limits.pageGrowthMb,
      last.heapMb - (warm ?? last.heapMb) <= limits.pageGrowthMb,
    ),
  ];
  process.stdout.write(
    `  page heap ${warm?.toFixed(1)} → ${last.heapMb.toFixed(1)} MB · ${limits.items.toLocaleString()} items\n`,
  );
  if (ok.includes(false)) failed = true;
});
if (failed) {
  process.stderr.write("long-thread performance budgets exceeded\n");
  process.exit(1);
}
