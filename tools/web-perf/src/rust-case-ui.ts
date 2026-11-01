/**
 * Front-end timings for the Rust-case profile (docs/perf/2026-11-rust-case.md): what the web
 * app spends with no real daemon behind it, so slowness a Rust daemon could not change shows.
 *
 * Start the two dev servers first (in apps/web):
 *   bun run dev:fake -- --port 5402 --strictPort      # scripted fake daemon in the page
 *   bunx vite --mode perf --port 5403 --strictPort    # synthetic long thread (?long=1)
 * then:
 *   node tools/web-perf/src/rust-case-ui.ts [--reps=5] [--out=FILE]
 *     [--playwright=…/playwright-core/index.mjs] [--chrome=…/Google Chrome for Testing]
 *
 * Both servers are Vite dev servers (unbundled modules), so load times are upper bounds.
 */
import { writeFile } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const argv = process.argv.slice(2);
const option = (name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const reps = Number(option("reps") ?? 5);
const fakeOrigin = option("fake") ?? "http://localhost:5402";
const perfOrigin = option("perf") ?? "http://localhost:5403";
const playwrightPath =
  option("playwright") ??
  join(homedir(), ".bun/install/cache/playwright-core@1.64.1@@@1/index.mjs");
const chrome =
  option("chrome") ??
  join(
    homedir(),
    "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );

const Playwright = z.object({
  chromium: z.object({ launch: z.function() }),
});
const playwright: unknown = await import(playwrightPath);
Playwright.parse(playwright);
// The shape was checked above; playwright-core's own types are not a dependency here.
const { chromium } = playwright as {
  chromium: { launch(options: object): Promise<Browser> };
};
interface Session {
  send(method: string, params?: object): Promise<unknown>;
}
interface Page {
  goto(url: string, options?: object): Promise<unknown>;
  evaluate<T>(fn: string | ((arg: never) => T), arg?: unknown): Promise<T>;
  waitForFunction(
    fn: string,
    arg?: unknown,
    options?: object,
  ): Promise<{ jsonValue(): Promise<unknown> }>;
  locator(selector: string): {
    first(): { click(): Promise<void> };
    nth(i: number): { click(): Promise<void>; getAttribute(n: string): Promise<string | null> };
    count(): Promise<number>;
  };
  mouse: { wheel(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
  context(): { newCDPSession(page: Page): Promise<Session> };
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
}
interface Browser {
  newContext(options: object): Promise<{ newPage(): Promise<Page> }>;
  close(): Promise<void>;
}

const Metrics = z.object({ metrics: z.array(z.object({ name: z.string(), value: z.number() })) });
/** Main-thread busy time by kind, in ms, from Chrome's cumulative counters. */
async function counters(session: Session) {
  const { metrics } = Metrics.parse(await session.send("Performance.getMetrics"));
  const read = (name: string) =>
    (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return {
    script: read("ScriptDuration"),
    layout: read("LayoutDuration"),
    style: read("RecalcStyleDuration"),
    task: read("TaskDuration"),
    heapMb: (metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0) / 1048576,
    nodes: metrics.find((metric) => metric.name === "Nodes")?.value ?? 0,
  };
}
const diff = (
  a: Awaited<ReturnType<typeof counters>>,
  b: Awaited<ReturnType<typeof counters>>,
) => ({
  scriptMs: Math.round(b.script - a.script),
  layoutMs: Math.round(b.layout - a.layout),
  styleMs: Math.round(b.style - a.style),
  taskMs: Math.round(b.task - a.task),
});
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

/** Long tasks from navigation start, collected in the page. */
const observeLongTasks = `(() => {
  globalThis.__long = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) globalThis.__long.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });
})()`;

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-precise-memory-info"],
});
// The production build's CSP forbids string evaluation, which page.waitForFunction uses.
const context = await browser.newContext({ bypassCSP: true });
const results: Record<string, unknown> = { reps, load: [] as number[] };
const loads = results["load"] as number[];
try {
  // 1. Time to interactive and the sidebar, fresh page each time.
  const loadsRuns = [];
  for (let rep = 0; rep < reps; rep++) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    await page.goto(fakeOrigin, { waitUntil: "commit" });
    await page.evaluate(observeLongTasks);
    const ready = await (
      await page.waitForFunction(
        `(() => { const nav = document.querySelector('nav[aria-label="Threads"]');
           const rows = nav ? nav.querySelectorAll('a[href*="/t/"]').length : 0;
           return rows > 0 ? { at: performance.now(), rows } : false; })()`,
        undefined,
        { timeout: 120_000, polling: "raf" },
      )
    ).jsonValue();
    const atReady = await counters(session);
    await page.waitForTimeout(3000);
    const timing = await page.evaluate(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
      const long = globalThis.__long;
      return {
        domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
        fcp: paint["first-contentful-paint"],
        resources: performance.getEntriesByType("resource").length,
        longTasks: long.length,
        longTaskMs: long.reduce((s, [, d]) => s + d, 0),
        blockingMs: long.reduce((s, [, d]) => s + Math.max(0, d - 50), 0),
        quietAt: long.length ? Math.max(...long.map(([s, d]) => s + d)) : 0,
      };
    })()`);
    loadsRuns.push({ ready, timing, mainThreadToReady: atReady });
    loads.push(loadavg()[0] ?? 0);
    await page.close();
  }
  const readyAt = loadsRuns.map((run) => z.object({ at: z.number() }).parse(run.ready).at);
  results["startup"] = { runs: loadsRuns, readyMedianMs: median(readyAt) };

  // 2. Opening threads from the sidebar in the fake world.
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await page.goto(fakeOrigin);
  await page.waitForFunction(
    `document.querySelectorAll('nav[aria-label="Threads"] a[href*="/t/"]').length > 0`,
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(2000);
  const links = page.locator('nav[aria-label="Threads"] a[href*="/t/"]');
  const total = await links.count();
  const opens = [];
  for (let index = 0; index < Math.min(total, 8); index++) {
    const href = await links.nth(index).getAttribute("href");
    const before = await counters(session);
    const started = Number(await page.evaluate("performance.now()"));
    await links.nth(index).click();
    const done = await (
      await page.waitForFunction(
        `(() => { const feed = document.querySelector('[role="feed"][aria-label="Transcript"]');
           if (!feed || feed.getAttribute("aria-busy") === "true") return false;
           const n = feed.querySelectorAll('[role="article"]').length;
           return n > 0 ? { at: performance.now(), articles: n } : false; })()`,
        undefined,
        { timeout: 60_000, polling: "raf" },
      )
    ).jsonValue();
    const parsed = z.object({ at: z.number(), articles: z.number() }).parse(done);
    await page.waitForTimeout(500);
    opens.push({
      href,
      ms: Math.round(parsed.at - started),
      articles: parsed.articles,
      main: diff(before, await counters(session)),
    });
  }
  results["openThread"] = { opens, medianMs: median(opens.map((open) => open.ms)) };
  await page.close();

  // 3. A long transcript (synthetic million-item thread) : open, then scroll frame times.
  const scrolls = [];
  for (let rep = 0; rep < Math.min(reps, 3); rep++) {
    const long = await context.newPage();
    await long.setViewportSize({ width: 1440, height: 900 });
    const cdp = await long.context().newCDPSession(long);
    await cdp.send("Performance.enable");
    const navStart = Date.now();
    await long.goto(`${perfOrigin}/t/thread-multi-day?long=1&rate=1`, { waitUntil: "commit" });
    await long.waitForFunction(
      `(() => { const feed = document.querySelector('[role="feed"][aria-label="Transcript"]');
         return feed && feed.querySelectorAll('[role="article"]').length > 5 && feed.getAttribute("aria-busy") !== "true"; })()`,
      undefined,
      { timeout: 120_000 },
    );
    const openMs = Date.now() - navStart;
    await long.waitForTimeout(2000);
    await long.mouse.move(900, 450);
    await long.evaluate(`(() => {
      globalThis.__frames = []; globalThis.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) globalThis.__long.push(e.duration); }).observe({ type: "longtask" });
      let last = performance.now();
      const tick = (now) => { globalThis.__frames.push(now - last); last = now; if (!globalThis.__stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    const before = await counters(cdp);
    // Read upward through history, as a person scrolls back, then down again.
    for (let step = 0; step < 60; step++) {
      await long.mouse.wheel(0, step < 40 ? -600 : 900);
      await long.waitForTimeout(50);
    }
    await long.waitForTimeout(500);
    const after = await counters(cdp);
    const frames = z
      .object({ frames: z.array(z.number()), long: z.array(z.number()) })
      .parse(
        await long.evaluate(
          `(() => { globalThis.__stop = true; return { frames: globalThis.__frames.slice(1), long: globalThis.__long }; })()`,
        ),
      );
    const sorted = frames.frames.toSorted((a, b) => a - b);
    const pick = (q: number) =>
      Math.round((sorted[Math.floor(q * (sorted.length - 1))] ?? 0) * 10) / 10;
    scrolls.push({
      openMs,
      frames: sorted.length,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      max: Math.round(sorted.at(-1) ?? 0),
      over16: Math.round((sorted.filter((ms) => ms > 16.8).length / sorted.length) * 1000) / 10,
      over33: Math.round((sorted.filter((ms) => ms > 33.4).length / sorted.length) * 1000) / 10,
      longTasks: frames.long.length,
      main: diff(before, after),
      nodes: after.nodes,
      heapMb: Math.round(after.heapMb),
    });
    loads.push(loadavg()[0] ?? 0);
    await long.close();
  }
  results["longScroll"] = scrolls;
} finally {
  await browser.close();
}
const text = `${JSON.stringify(results, null, 2)}\n`;
const out = option("out");
if (out) await writeFile(out, text);
process.stdout.write(text);
