import { chromium, type Page } from "@playwright/test";
import type { FakeDaemon } from "@ace/fake-daemon";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";

/*
 * What the sidebar's live status icons cost while nothing else happens: the fake app (`vite
 * --mode fake`) with `ACE_ICON_PERF_THREADS` (20) working threads in the sidebar, recorded for
 * `ACE_ICON_PERF_SECONDS` (6) with Chrome's timeline tracing, under full motion and under
 * Reduce motion. Prints main-thread scripting, rendering and painting time per second, and how
 * many Layout and Paint events ran per second (a per-frame layout or paint would be ~60/s).
 *
 *   ACE_ICON_PERF_URL=http://localhost:5190 node tools/web-e2e/src/status-icon-perf.ts
 */

const base = process.env.ACE_ICON_PERF_URL ?? "http://localhost:5190";
const threads = Number(process.env.ACE_ICON_PERF_THREADS ?? 20);
const seconds = Number(process.env.ACE_ICON_PERF_SECONDS ?? 6);
const out = process.env.ACE_ICON_PERF_OUT ?? "/tmp/ace-aperture/perf";

/** A Chrome trace event, as much of it as the summary reads. */
const TraceEvent = z.object({
  name: z.string(),
  ph: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  pid: z.number(),
  tid: z.number(),
  args: z.looseObject({ name: z.unknown().optional() }).optional(),
});
type TraceEvent = z.infer<typeof TraceEvent>;

const scripting = new Set([
  "FunctionCall",
  "EvaluateScript",
  "TimerFire",
  "EventDispatch",
  "RunMicrotasks",
  "FireAnimationFrame",
  "v8.compile",
  "V8.CompileCode",
  "MajorGC",
  "MinorGC",
  "V8.GC_SCAVENGER",
]);
const rendering = new Set([
  "UpdateLayoutTree",
  "RecalculateStyles",
  "Layout",
  "UpdateLayerTree",
  "PrePaint",
  "HitTest",
  "IntersectionObserverController::computeIntersections",
]);
const painting = new Set(["Paint", "PaintImage", "Layerize", "Commit", "CompositeLayers"]);

async function stage(page: Page, motion: "no-preference" | "reduce") {
  await page.emulateMedia({ reducedMotion: motion });
  await page.addInitScript((count) => {
    localStorage.setItem("ace.appearance", JSON.stringify({ mode: "dark" }));
    Object.assign(globalThis, {
      aceFakeWorld: "empty",
      aceFakeSetup: (daemon: FakeDaemon) => {
        daemon.services.providerLogin.dismiss("web-fake-device");
        daemon.services.settings.seed({ "threads.autoSettleAfter": "never" });
        for (let index = 0; index < count; index++) {
          const id = `working-${index}`;
          daemon.createThread(
            {
              id,
              title: `Working thread ${index + 1}`,
              provider: "codex",
              workspaceId: "ace",
              details: {
                workspace: { id: "ace", name: "ace", path: "/tmp/synthetic-project" },
                machine: { host: daemon.hostId, name: "This Mac" },
              },
            },
            30_000,
          );
          daemon.apply(
            id,
            [
              {
                type: "agent.seen",
                agent: "root",
                origin: "root",
                fidelity: "full",
                native: { provider: "codex", nativeId: "root" },
                cwd: "/tmp/synthetic-project",
              },
              { type: "turn.started", agent: "root", nativeTurnId: "turn", trigger: "user" },
              {
                type: "item.upsert",
                agent: "root",
                item: "sent",
                draft: {
                  type: "message",
                  role: "user",
                  complete: true,
                  parts: [{ type: "text", text: "Keep working" }],
                },
              },
            ],
            30_000,
          );
        }
      },
    });
  }, threads);
  await page.goto(`${base}/new`);
  await page
    .getByRole("navigation", { name: "Threads" })
    .getByRole("link", { name: /^Working thread \d+/ })
    .first()
    .waitFor()
    .catch(async (error: unknown) => {
      await page.screenshot({ path: `${out}/stage-failed.png` });
      throw error;
    });
  // Let boot work, fonts and the first second ticks settle before recording.
  await page.waitForTimeout(2500);
}

async function record(page: Page): Promise<TraceEvent[]> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (data) => {
    for (const raw of data.value) {
      const event = TraceEvent.safeParse(raw);
      if (event.success) events.push(event.data);
    }
  });
  const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "v8.execute",
        "blink",
        "blink.animations",
        "cc",
        "gpu",
        "viz",
      ],
    },
  });
  await page.waitForTimeout(seconds * 1000);
  await cdp.send("Tracing.end");
  await done;
  return events;
}

function summarise(events: TraceEvent[]) {
  const threadNamed = (name: string) =>
    events.find((event) => event.name === "thread_name" && event.args?.name === name);
  const on = (thread: TraceEvent | undefined) =>
    events.filter(
      (event) => thread && event.pid === thread.pid && event.tid === thread.tid && event.ph === "X",
    );
  // Only top-level time: nested events of the same family are not counted twice.
  const sum = (list: TraceEvent[], names?: Set<string>) => {
    let total = 0;
    let end = -1;
    for (const event of list
      .filter((item) => !names || names.has(item.name))
      .toSorted((a, b) => a.ts - b.ts)) {
      if (event.ts >= end) {
        total += event.dur ?? 0;
        end = event.ts + (event.dur ?? 0);
      }
    }
    return +(total / 1000 / seconds).toFixed(2);
  };
  const main = on(threadNamed("CrRendererMain"));
  const compositor = on(threadNamed("Compositor"));
  const count = (list: TraceEvent[], name: string) =>
    +(list.filter((event) => event.name === name).length / seconds).toFixed(1);
  const tasks = (list: TraceEvent[]) => list.filter((event) => event.name === "RunTask");
  const animations = events.filter(
    (event) => event.name === "Animation" && event.ph === "n" && event.args,
  );
  return {
    mainThreadMsPerSecond: {
      scripting: sum(main, scripting),
      rendering: sum(main, rendering),
      painting: sum(main, painting),
      total: sum(tasks(main)),
    },
    mainThreadPerSecond: {
      layout: count(main, "Layout"),
      paint: count(main, "Paint"),
      styleRecalc: count(main, "UpdateLayoutTree"),
      commit: count(main, "Commit"),
    },
    compositor: {
      framesPerSecond: count(compositor, "ProxyImpl::ScheduledActionDraw"),
      threadMsPerSecond: sum(tasks(compositor)),
      vizThreadMsPerSecond: sum(tasks(on(threadNamed("VizCompositorThread")))),
      rasterMsPerSecond: sum(events.filter((event) => event.name === "RasterTask")),
    },
    // Animations Chrome could not hand to the compositor, with its reasons.
    notComposited: animations
      .map((event) => JSON.stringify(event.args))
      .filter((args) => args.includes("compositeFailed") && !args.includes('"compositeFailed":0'))
      .slice(0, 5),
  };
}

/**
 * The composited layers the page has, with why: an animated status-glyph part shows up as a
 * small layer with an active transform or opacity animation, so the compositor runs it.
 */
async function animatedLayers(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const tree = new Promise<{ layerId: string; width: number; height: number }[]>((resolve) =>
    cdp.once("LayerTree.layerTreeDidChange", (event) => resolve(event.layers ?? [])),
  );
  await cdp.send("LayerTree.enable");
  const layers = await tree;
  const animated: string[] = [];
  for (const layer of layers) {
    const { compositingReasonIds = [] } = await cdp
      .send("LayerTree.compositingReasons", { layerId: layer.layerId })
      .catch(() => ({ compositingReasonIds: [] as string[] }));
    if (compositingReasonIds.some((reason) => /animation/i.test(reason)))
      animated.push(`${layer.width}x${layer.height} ${compositingReasonIds.join("+")}`);
  }
  await cdp.send("LayerTree.disable");
  const sizes = new Map<string, number>();
  for (const entry of animated) sizes.set(entry, (sizes.get(entry) ?? 0) + 1);
  return { layers: layers.length, animated: animated.length, kinds: Object.fromEntries(sizes) };
}

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-gpu-rasterization"] });
const label = process.env.ACE_ICON_PERF_LABEL ?? "run";
const results: Record<string, unknown> = {};
// "still": the same page with every status-glyph and spinner animation stopped, the floor the
// live runs are compared against (the per-second clock still ticks in it).
const runs = [
  ["no-preference", false],
  ["reduce", false],
  ["no-preference", true],
] as const;
try {
  for (const [motion, still] of runs) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await stage(page, motion);
    if (still)
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; }",
      });
    const layers = await animatedLayers(page);
    const events = await record(page);
    const name = still ? "still" : motion;
    await writeFile(`${out}/${label}-${name}.json`, JSON.stringify({ traceEvents: events }));
    results[name] = { ...summarise(events), layers };
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ label, threads, seconds, results }, null, 2));
