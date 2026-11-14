import { expect, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import { report } from "./measure.ts";
import { scrollTranscript } from "./navigation.ts";
import { open } from "./perf-app.ts";

/*
 * A finished answer whose row mounts again (scrolled out of the virtualised transcript and back,
 * or the reader switched threads and returned) must come back as it was: no frame of its raw
 * text, no change in its height and no new markit job. Counted on one answer at the live end:
 * raw-text placeholders added for its text (a MutationObserver), markit renders of its length
 * (`acePerf.markit`), and the difference between its height before and after.
 */

/** The second thread of the synthetic long thread: one of its subagents. */
const otherThread = "/t/thread-multi-day.child.1";

const Watch = z.object({ placeholders: z.number(), renders: z.number(), all: z.number() });
type Watch = z.infer<typeof Watch>;

async function startWatch(page: Page, text: string): Promise<void> {
  await page.evaluate((target) => {
    // Only `?markdown=1` collects markit's renders by default; this page collects them while
    // the probe watches.
    const perf = Reflect.get(globalThis, "acePerf") as { markit?: unknown[] } | undefined;
    if (perf && !Array.isArray(perf.markit)) perf.markit = [];
    const state = { placeholders: 0, start: perf?.markit?.length ?? 0, target };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const found = node.matches(".markit-ace > p.whitespace-pre-wrap")
            ? [node]
            : [...node.querySelectorAll(".markit-ace > p.whitespace-pre-wrap")];
          state.placeholders += found.filter((p) => p.textContent === target).length;
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Reflect.set(globalThis, "__remountWatch", { state, observer });
  }, text);
}

async function stopWatch(page: Page): Promise<Watch> {
  return Watch.parse(
    await page.evaluate(() => {
      const watch = Reflect.get(globalThis, "__remountWatch") as {
        state: { placeholders: number; start: number; target: string };
        observer: MutationObserver;
      };
      watch.observer.disconnect();
      const perf = Reflect.get(globalThis, "acePerf") as
        | { markit?: Array<{ chars: number }> }
        | undefined;
      const samples = perf?.markit?.slice(watch.state.start) ?? [];
      return {
        placeholders: watch.state.placeholders,
        renders: samples.filter((sample) => sample.chars === watch.state.target.length).length,
        all: samples.length,
      };
    }),
  );
}

/** Scrolls an answer out of the transcript and back, then switches threads and returns. */
export async function probeRemount(browser: Browser, origin: string): Promise<boolean> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    return await probe(page, origin);
  } finally {
    await page.close();
  }
}

async function probe(page: Page, origin: string): Promise<boolean> {
  await open(page, `${origin}/t/thread-multi-day?long=1&rate=1`);
  const feed = page.getByRole("feed", { name: "Transcript" });
  const toEnd = page.getByRole("button", { name: /^Scroll to end/ }).first();
  if (await toEnd.isVisible()) {
    await toEnd.click();
    await toEnd.waitFor({ state: "detached" });
  }
  const answers = feed.locator(".markit-ace").filter({ hasText: /^Checkpoint \d+ completed\./ });
  await expect.poll(() => answers.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  const text = (await answers.last().textContent())?.trim() ?? "";
  const answer = feed.locator(".markit-ace").filter({ hasText: text });
  const height = () => answer.first().evaluate((node) => node.getBoundingClientRect().height);
  const settled = async () => {
    await answer.first().waitFor();
    // Long enough for a markit job and its frame to land.
    await page.waitForTimeout(400);
  };
  await settled();

  const before = await height();
  await startWatch(page, text);
  await feed.hover();
  for (let step = 0; step < 30 && (await answer.count()) > 0; step++)
    await scrollTranscript(page, -1_500, 60);
  if ((await answer.count()) > 0) throw new Error("The answer never left the transcript");
  await toEnd.click();
  await toEnd.waitFor({ state: "detached" });
  await settled();
  const scrolled = await stopWatch(page);
  const scrolledShift = Math.abs((await height()) - before);

  await startWatch(page, text);
  const from = new URL(page.url());
  await page.evaluate((path) => {
    history.pushState(history.state, "", path);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, otherThread);
  await expect(answer).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(300);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(from.href);
  await settled();
  const switched = await stopWatch(page);
  const switchedShift = Math.abs((await height()) - before);

  return [
    report(
      "remount after scroll: raw-text frames",
      scrolled.placeholders,
      0,
      scrolled.placeholders === 0,
    ),
    report(
      "remount after scroll: markit renders of it",
      scrolled.renders,
      0,
      scrolled.renders === 0,
    ),
    report("remount after scroll: markit renders, all rows", scrolled.all, "report", true),
    report("remount after scroll: height change (px)", scrolledShift, 0, scrolledShift < 0.5),
    report(
      "remount after switch: raw-text frames",
      switched.placeholders,
      0,
      switched.placeholders === 0,
    ),
    report(
      "remount after switch: markit renders of it",
      switched.renders,
      0,
      switched.renders === 0,
    ),
    report("remount after switch: markit renders, all rows", switched.all, "report", true),
    report("remount after switch: height change (px)", switchedShift, 0, switchedShift < 0.5),
  ].every(Boolean);
}
