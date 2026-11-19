import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { report } from "./measure.ts";
import { scrollTranscript } from "./navigation.ts";
import { checkpointAnswer } from "@ace/fake-daemon";
import { open } from "./perf-app.ts";

/*
 * A finished answer whose row mounts again (scrolled out of the virtualised transcript and back,
 * or the reader switched threads and returned) must come back as it was: no frame of its raw
 * text, no change in its height and no new markit job. Measured on the long thread's last
 * answer, which runs to several blocks with a code fence (`checkpointAnswer`), so its plain text
 * is far taller than its drawing: raw-text placeholders added for it (a MutationObserver),
 * markit renders of its length (`acePerf.markit`), and its height before and after. A page of
 * its own, with one live item a second, so the answer is still at the live end.
 */

/** The second thread of the synthetic long thread: one of its subagents. */
const otherThread = "/t/thread-multi-day.child.1";
/** The synthetic thread's last turn, whose answer the probe follows. */
const lastTurn = 2_000;

const Watch = z.object({
  placeholders: z.number(),
  renders: z.number(),
  all: z.number(),
  shift: z.number(),
});
type Watch = z.infer<typeof Watch>;

/** Watches for the answer that opens with `opening` and is `length` characters of markdown. */
/** `height`: the answer drawn; every frame it shows in while watched is measured against it. */
async function startWatch(
  page: Page,
  opening: string,
  length: number,
  height: number,
): Promise<void> {
  await page.evaluate(
    (target) => {
      // Only `?markdown=1` collects markit's renders by default; this page collects them while
      // the probe watches.
      const perf = Reflect.get(globalThis, "acePerf") as { markit?: unknown[] } | undefined;
      if (perf && !Array.isArray(perf.markit)) perf.markit = [];
      const state = {
        placeholders: 0,
        start: perf?.markit?.length ?? 0,
        length: target.length,
        shift: 0,
        watching: true,
      };
      // Each painted frame the answer is in: how far its height is from its drawn height.
      const frame = () => {
        if (!state.watching) return;
        for (const node of document.querySelectorAll(".markit-ace"))
          if (node.textContent?.startsWith(target.opening))
            state.shift = Math.max(
              state.shift,
              Math.abs(node.getBoundingClientRect().height - target.height),
            );
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const selector = ".markit-ace > p.whitespace-pre-wrap";
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const found = node.matches(selector) ? [node] : [...node.querySelectorAll(selector)];
            state.placeholders += found.filter((p) =>
              p.textContent?.startsWith(target.opening),
            ).length;
          }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      Reflect.set(globalThis, "__remountWatch", { state, observer });
    },
    { opening, length, height },
  );
}

async function stopWatch(page: Page): Promise<Watch> {
  return Watch.parse(
    await page.evaluate(() => {
      const watch = Reflect.get(globalThis, "__remountWatch") as {
        state: {
          placeholders: number;
          start: number;
          length: number;
          shift: number;
          watching: boolean;
        };
        observer: MutationObserver;
      };
      watch.observer.disconnect();
      watch.state.watching = false;
      const perf = Reflect.get(globalThis, "acePerf") as
        | { markit?: Array<{ chars: number }> }
        | undefined;
      const samples = perf?.markit?.slice(watch.state.start) ?? [];
      return {
        placeholders: watch.state.placeholders,
        renders: samples.filter((sample) => sample.chars === watch.state.length).length,
        all: samples.length,
        shift: watch.state.shift,
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

/** Drawn: markit's blocks are in and the plain-text stand-in gone (only a drawn answer is kept). */
async function settled(page: Page, answer: Locator): Promise<void> {
  await answer.waitFor();
  await expect(answer.locator(":scope > p.whitespace-pre-wrap")).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(answer.locator(".markit .mk-block").first()).toBeAttached();
  // Long enough for a late markit job and its frame to land.
  await page.waitForTimeout(400);
}

async function probe(page: Page, origin: string): Promise<boolean> {
  await open(page, `${origin}/t/thread-multi-day?long=1&rate=1`);
  const feed = page.getByRole("feed", { name: "Transcript" });
  const toEnd = page.getByRole("button", { name: /^Scroll to end/ }).first();
  const markdown = checkpointAnswer(lastTurn);
  const opening = `Checkpoint ${lastTurn} completed.`;
  const answer = feed.locator(".markit-ace").filter({ hasText: opening }).first();
  await answer.waitFor({ timeout: 30_000 });
  if ((await answer.locator("section[data-markit-code]").count()) === 0)
    await expect(answer.locator("section[data-markit-code]")).toHaveCount(1, { timeout: 20_000 });
  await settled(page, answer);
  const height = () => answer.evaluate((node) => node.getBoundingClientRect().height);
  const before = await height();

  await startWatch(page, opening, markdown.length, before);
  await feed.hover();
  for (let step = 0; step < 30 && (await answer.count()) > 0; step++)
    await scrollTranscript(page, -1_500, 60);
  if ((await answer.count()) > 0) throw new Error("The answer never left the transcript");
  await expect(toEnd).toBeVisible({ timeout: 20_000 });
  await toEnd.click();
  await toEnd.waitFor({ state: "detached" });
  await settled(page, answer);
  const scrolled = await stopWatch(page);

  await startWatch(page, opening, markdown.length, before);
  const from = page.url();
  await page.evaluate((path) => {
    history.pushState(history.state, "", path);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, otherThread);
  await expect(answer).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(300);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(from);
  await settled(page, answer);
  const switched = await stopWatch(page);

  process.stdout.write(
    `  remount probe: an answer of ${before.toFixed(0)} px drawn, with a code fence\n`,
  );
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
    report(
      "remount after scroll: height change in a frame (px)",
      scrolled.shift,
      0,
      scrolled.shift < 0.5,
    ),
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
    report(
      "remount after switch: height change in a frame (px)",
      switched.shift,
      0,
      switched.shift < 0.5,
    ),
  ].every(Boolean);
}
