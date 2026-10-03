import type { Browser, CDPSession, Page } from "@playwright/test";
import { budgets } from "./budgets.ts";
import { open, withPerfApp } from "./perf-app.ts";

/*
 * Memory and load budgets in a real browser (ADR 0056), against the production build in
 * `--mode perf`:
 * - Load: first contentful paint and the moment the transcript and composer are usable.
 * - A 1,000,000-item thread: paging back through its history keeps the client's window, the
 *   DOM and both heaps bounded.
 * - Streaming: N minutes at 5,000 events/s; the page heap, the client worker's heap and the
 *   DOM must stay flat. Heaps are read after forced garbage collection, so growth is what is
 *   retained. `MEMORY_MINUTES` lengthens the run (the default suits CI).
 */

const port = 5_198;
const minutes = Number(process.env.MEMORY_MINUTES ?? budgets.memory.minutes);
const historyPages = Number(process.env.MEMORY_PAGES ?? 60);
const mb = (bytes: number) => bytes / 1024 / 1024;

interface Sample {
  pageMb: number;
  workerMb: number;
  nodes: number;
  listeners: number;
  articles: number;
}

/** The client worker's heap, through the browser's own DevTools session (flat protocol off). */
async function workerHeap(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find(
      (info) =>
        (info.type === "worker" || info.type === "shared_worker") &&
        /client/.test(info.title + info.url),
    );
    if (!target) return Number.NaN;
    const { sessionId } = await session.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    let id = 0;
    const call = (method: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const ask = ++id;
        const listener = (event: { sessionId?: string; message: string }) => {
          const reply = JSON.parse(event.message) as {
            id?: number;
            result?: Record<string, unknown>;
          };
          if (event.sessionId !== sessionId || reply.id !== ask) return;
          session.off("Target.receivedMessageFromTarget", listener);
          resolve(reply.result ?? {});
        };
        session.on("Target.receivedMessageFromTarget", listener);
        void session.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: ask, method }),
        });
      });
    await call("HeapProfiler.enable");
    await call("HeapProfiler.collectGarbage");
    await call("HeapProfiler.collectGarbage");
    const usage = await call("Runtime.getHeapUsage");
    await session.send("Target.detachFromTarget", { sessionId });
    return typeof usage.usedSize === "number" ? usage.usedSize : Number.NaN;
  } finally {
    await session.detach();
  }
}

async function sample(browser: Browser, page: Page, cdp: CDPSession): Promise<Sample> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const counters = await cdp.send("Memory.getDOMCounters");
  const articles = await page
    .getByRole("feed", { name: "Transcript" })
    .getByRole("article")
    .count();
  return {
    pageMb: mb(heap.usedSize),
    workerMb: mb(await workerHeap(browser)),
    nodes: counters.nodes,
    listeners: counters.jsEventListeners,
    articles,
  };
}

const line = (label: string, value: string) =>
  process.stdout.write(`  ${label.padEnd(54)} ${value}\n`);
const describe = (s: Sample) =>
  `page ${s.pageMb.toFixed(1)} MB · worker ${s.workerMb.toFixed(1)} MB · ${s.nodes} DOM nodes · ${s.articles} rows`;

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

await withPerfApp(port, async ({ browser, origin }) => {
  // Load and a huge thread: the stream barely moves, so the reader can page back.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await open(page, `${origin}/t/thread-soak?rate=20&history=1000000`);
    const feed = page.getByRole("feed", { name: "Transcript" });
    await feed.waitFor({ timeout: 30_000 });
    await page.locator("textarea").first().waitFor();
    const load = await page.evaluate(() => ({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.NaN,
      ready: performance.now(),
    }));
    line("first contentful paint", `${load.fcp.toFixed(0)} ms`);
    line("transcript and composer usable", `${load.ready.toFixed(0)} ms`);
    check(
      load.ready <= budgets.memory.readyMs,
      `ready after ${load.ready.toFixed(0)} ms (budget ${budgets.memory.readyMs})`,
    );
    await feed.getByRole("article").nth(4).waitFor({ timeout: 30_000 });
    const loaded = await sample(browser, page, cdp);
    line("thread loaded (1M items of history)", describe(loaded));
    // Scroll to the top as a reader would; the transcript pages older history in by itself.
    for (let n = 0; n < historyPages; n++) {
      await page.evaluate(() => {
        const viewport = document.querySelector("[data-virtual-viewport]");
        if (viewport) viewport.scrollTop = 0;
      });
      await page.waitForTimeout(150);
      await page.waitForFunction(
        () => document.querySelector('[role="feed"]')?.getAttribute("aria-busy") !== "true",
      );
    }
    await page.waitForTimeout(500);
    const paged = await sample(browser, page, cdp);
    line(`after paging back ${historyPages} times`, describe(paged));
    check(
      paged.nodes <= budgets.memory.domNodes,
      `${paged.nodes} DOM nodes after paging back (budget ${budgets.memory.domNodes})`,
    );
    check(
      paged.pageMb - loaded.pageMb <= budgets.memory.pageGrowthMb,
      `page heap grew ${(paged.pageMb - loaded.pageMb).toFixed(1)} MB paging back (budget ${budgets.memory.pageGrowthMb})`,
    );
    await page.close();
  }
  // Streaming at full rate for N minutes.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await open(page, `${origin}/t/thread-soak?rate=${budgets.browser.eventsPerSecond}`);
    await page.getByRole("feed", { name: "Transcript" }).getByRole("article").first().waitFor({
      timeout: 30_000,
    });
    // Warm up: caches and the window fill, the JIT settles.
    await page.waitForTimeout(20_000);
    const first = await sample(browser, page, cdp);
    const startEvents = await page.evaluate(() => Reflect.get(globalThis, "acePerf")?.events ?? 0);
    line("streaming, warmed up", describe(first));
    const samples = [first];
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until) {
      await page.waitForTimeout(Math.min(30_000, Math.max(0, until - Date.now())));
      samples.push(await sample(browser, page, cdp));
    }
    const last = samples.at(-1) ?? first;
    const events =
      (await page.evaluate(() => Reflect.get(globalThis, "acePerf")?.events ?? 0)) - startEvents;
    line(`after ${minutes} min (${events.toLocaleString()} events)`, describe(last));
    const peak = (pick: (s: Sample) => number) => Math.max(...samples.map(pick));
    line(
      "peak",
      `page ${peak((s) => s.pageMb).toFixed(1)} MB · worker ${peak((s) => s.workerMb).toFixed(1)} MB · ${peak((s) => s.nodes)} DOM nodes`,
    );
    const pageGrowth = last.pageMb - first.pageMb;
    const workerGrowth = last.workerMb - first.workerMb;
    line(
      "retained growth",
      `page ${pageGrowth.toFixed(1)} MB · worker ${workerGrowth.toFixed(1)} MB`,
    );
    check(
      pageGrowth <= budgets.memory.pageGrowthMb,
      `page heap grew ${pageGrowth.toFixed(1)} MB streaming (budget ${budgets.memory.pageGrowthMb})`,
    );
    check(
      !(workerGrowth > budgets.memory.workerGrowthMb),
      `client worker heap grew ${workerGrowth.toFixed(1)} MB streaming (budget ${budgets.memory.workerGrowthMb})`,
    );
    check(
      peak((s) => s.nodes) <= budgets.memory.domNodes,
      `${peak((s) => s.nodes)} DOM nodes streaming (budget ${budgets.memory.domNodes})`,
    );
    check(!Number.isNaN(last.workerMb), "the client worker's heap could not be read");
    await page.close();
  }
});

if (failures.length) {
  for (const failure of failures) process.stderr.write(`memory budget: ${failure}\n`);
  process.exit(1);
}
