import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { z } from "zod";

/** Opt-in fake-build observation. Never starts a daemon or a provider session. */
const origin = process.argv[2];
const out = process.argv[3];
if (!origin || !out) throw new Error("Usage: steady-motion.ts <fake-build-origin> <output-dir>");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const Event = z.object({
  name: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  pid: z.number(),
  tid: z.number(),
});
const observed = new Set([
  "DrawFrame",
  "Paint",
  "CompositeLayers",
  "ThreadControllerImpl::RunTask",
  "thread_name",
]);
const report = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  for (const fixture of ["thread-worktree-cleanup", "thread-sheet-rotate", "thread-pdf-locale"]) {
    await page.goto(`${origin}/t/${fixture}`);
    await page.getByRole("feed", { name: "Transcript" }).waitFor({ timeout: 60_000 });
    await page.getByRole("combobox", { name: "Message" }).waitFor({ timeout: 60_000 });
    await page.locator("body").click({ position: { x: 1000, y: 80 } });
    await page.waitForTimeout(1500);
    const variants =
      fixture === "thread-worktree-cleanup"
        ? ["default", "spinner-static", "all-static", "all-static-no-blur", "hidden"]
        : ["default"];
    for (const variant of variants) {
      let style;
      let front;
      if (variant === "spinner-static")
        style = await page.addStyleTag({ content: ".spin-ring { animation: none !important; }" });
      if (variant.startsWith("all-static"))
        style = await page.addStyleTag({
          content: `*,*::before,*::after { animation: none !important; } ${variant.endsWith("no-blur") ? "* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" : ""}`,
        });
      if (variant === "hidden") {
        front = await page.context().newPage();
        await front.bringToFront();
      }
      const visibility = await page.evaluate(() => document.visibilityState);
      const loops = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getComputedTiming().iterations === Infinity,
            ).length,
      );
      const events: z.infer<typeof Event>[] = [];
      const collect = (chunk: { value: unknown[] }) => {
        for (const raw of chunk.value) {
          const event = Event.safeParse(raw);
          if (event.success && observed.has(event.data.name)) events.push(event.data);
        }
      };
      cdp.on("Tracing.dataCollected", collect);
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel",
        transferMode: "ReportEvents",
      });
      const start = await page.evaluate(() => performance.now());
      await page.waitForTimeout(15_000);
      const finish = await page.evaluate(() => performance.now());
      const ended = new Promise<void>((resolve) =>
        cdp.once("Tracing.tracingComplete", () => resolve()),
      );
      await cdp.send("Tracing.end");
      await ended;
      cdp.removeListener("Tracing.dataCollected", collect);
      const counts = Object.fromEntries(
        ["DrawFrame", "Paint", "CompositeLayers"].map((name) => [
          name,
          events.filter((event) => event.name === name).length,
        ]),
      );
      const sample = {
        fixture,
        variant,
        visibility,
        valid: variant !== "hidden" || visibility === "hidden",
        loops,
        observationMs: finish - start,
        counts,
      };
      report.push(sample);
      await writeFile(`${out}/${fixture}-${variant}.json`, JSON.stringify({ sample, events }));
      process.stdout.write(`${JSON.stringify(sample)}\n`);
      await style?.evaluate((node) => node.parentNode?.removeChild(node));
      await front?.close();
      await page.bringToFront();
    }
  }
  await writeFile(`${out}/summary.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
