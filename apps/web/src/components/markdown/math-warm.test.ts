import { expect, test, vi } from "vitest";
import {
  mathFontUrls,
  readWarmHints,
  scheduleMathWarmup,
  scheduleWhenIdle,
  shouldWarmMath,
  warmMathNow,
  type IdleScheduler,
} from "./math-warm.ts";

test("metered and mobile links never warm", () => {
  expect(shouldWarmMath({})).toBe(true);
  expect(shouldWarmMath({ saveData: true })).toBe(false);
  expect(shouldWarmMath({ effectiveType: "2g" })).toBe(false);
  expect(shouldWarmMath({ effectiveType: "slow-2g" })).toBe(false);
  expect(shouldWarmMath({ effectiveType: "4g" })).toBe(true);
  expect(shouldWarmMath({ mobile: true })).toBe(false);
});

/** A scheduler whose idle callbacks and timers only fire when the test fires them. */
const toTimerId = (id: number) => id as unknown as ReturnType<typeof setTimeout>;
const fromTimerId = (id: ReturnType<typeof setTimeout>) => id as unknown as number;
function manualScheduler() {
  const idle = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    scheduler: {
      requestIdleCallback: (work: () => void) => {
        const id = next++;
        idle.set(id, work);
        return id;
      },
      cancelIdle: (id: number) => void idle.delete(id),
      setTimeout: (work: () => void) => {
        const id = next++;
        timers.set(id, work);
        return toTimerId(id);
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => void timers.delete(fromTimerId(id)),
    } satisfies IdleScheduler,
    fireIdle: (id = 1) => idle.get(id)?.(),
    fireTimers: () => {
      const runs = [...timers.values()];
      timers.clear();
      for (const run of runs) run();
    },
    get pendingIdle() {
      return idle.size;
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

test("idle work runs when the page is idle and can be cancelled", () => {
  const clock = manualScheduler();
  const work = vi.fn();
  const cancel = scheduleWhenIdle(clock.scheduler, work, 3000);
  expect(work).not.toHaveBeenCalled();
  // The safety net is armed alongside the idle callback.
  expect(clock.pendingIdle).toBe(1);
  expect(clock.pendingTimers).toBe(1);
  clock.fireIdle();
  expect(work).toHaveBeenCalledTimes(1);
  // The idle callback won: its safety net is gone.
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
  cancel();
});

test("a cancelled warm-up never runs, idle or timeout", () => {
  const clock = manualScheduler();
  const work = vi.fn();
  const cancel = scheduleWhenIdle(clock.scheduler, work, 3000);
  cancel();
  clock.fireIdle();
  clock.fireTimers();
  expect(work).not.toHaveBeenCalled();
});

test("the safety net fires when idle callbacks never come", () => {
  const clock = manualScheduler();
  const work = vi.fn();
  scheduleWhenIdle(clock.scheduler, work, 3000);
  // Idle never fires (ace's own browser has that bug): the timeout still runs the work, once.
  clock.fireTimers();
  expect(work).toHaveBeenCalledTimes(1);
  clock.fireIdle();
  expect(work).toHaveBeenCalledTimes(1);
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

test("without an idle callback the work still runs, shortly after interactivity", () => {
  vi.useFakeTimers();
  try {
    const scheduler: IdleScheduler = {
      setTimeout: (work, ms) => setTimeout(work, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    const work = vi.fn();
    const cancel = scheduleWhenIdle(scheduler, work);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(work).toHaveBeenCalledTimes(1);
    cancel();
  } finally {
    vi.useRealTimers();
  }
});

test("warm-up is skipped where it should not download", () => {
  const importMath = vi.fn(async () => ({}));
  const cancel = scheduleMathWarmup({
    scheduler: {
      requestIdleCallback: () => {
        throw new Error("must never schedule");
      },
      setTimeout: (work) => setTimeout(work, 0),
      clearTimeout: (id) => clearTimeout(id),
    },
    hints: { saveData: true },
    importMath,
  });
  cancel();
  expect(importMath).not.toHaveBeenCalled();
});

test("scheduled warm-up loads the chunk at idle", () => {
  const scheduled = new Map<number, () => void>();
  const importMath = vi.fn(async () => ({}));
  scheduleMathWarmup({
    scheduler: {
      requestIdleCallback: (work) => {
        const id = 1;
        scheduled.set(id, work);
        return id;
      },
      setTimeout: (work) => setTimeout(work, 0),
      clearTimeout: (id) => clearTimeout(id),
    },
    hints: {},
    importMath,
    document: undefined,
    fonts: undefined,
  });
  expect(importMath).not.toHaveBeenCalled();
  scheduled.get(1)?.();
  expect(importMath).toHaveBeenCalledTimes(1);
});

test("warming loads the chunk and preloads the fonts, once each", async () => {
  const document = window.document;
  const importMath = vi.fn(async () => ({}));
  const fonts = ["https://cdn.example.com/a.woff2", "https://cdn.example.com/b.woff2"];
  await warmMathNow({ importMath, document, fonts });
  await warmMathNow({ importMath, document, fonts });
  expect(importMath).toHaveBeenCalledTimes(2);
  const links = [...document.head.querySelectorAll("link[data-math-font]")];
  expect(links.map((link) => link.getAttribute("href")).toSorted()).toEqual([...fonts].toSorted());
  expect(links.every((link) => link.getAttribute("rel") === "preload")).toBe(true);
  for (const link of links) link.remove();
});

test("warming survives a failed chunk load", async () => {
  await warmMathNow({ importMath: () => Promise.reject(new Error("offline")) });
});

test("the preloaded fonts are the few common woff2 files", () => {
  expect(mathFontUrls).toHaveLength(5);
  expect(mathFontUrls.every((url) => url.endsWith(".woff2"))).toBe(true);
  for (const name of [
    "Main-Regular",
    "Math-Italic",
    "Size1-Regular",
    "Size2-Regular",
    "AMS-Regular",
  ])
    expect(mathFontUrls.some((url) => url.includes(name))).toBe(true);
});

test("hints reflect the platform", () => {
  expect(readWarmHints()).toEqual({});
});

/** A fresh warm module, so scheduling-once tests never share state. */
async function freshWarm() {
  vi.resetModules();
  return import("./math-warm.ts");
}

test("booting the app shell schedules exactly one warm-up", async () => {
  const warm = await freshWarm();
  const clock = manualScheduler();
  const importMath = vi.fn(async () => ({}));
  const trigger = {
    scheduler: clock.scheduler,
    hints: {},
    importMath,
    document: undefined,
    fonts: undefined,
  };
  // Boot triggers, then prose and the thread route trigger: only the first schedules.
  warm.scheduleMathWarmup(trigger);
  warm.scheduleMathWarmup({ ...trigger });
  warm.scheduleMathWarmup({ ...trigger });
  expect(clock.pendingIdle).toBe(1);
  expect(clock.pendingTimers).toBe(1);
  clock.fireIdle();
  expect(importMath).toHaveBeenCalledTimes(1);
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
});

test("a gated-out trigger schedules nothing and consumes nothing", async () => {
  const warm = await freshWarm();
  const clock = manualScheduler();
  const importMath = vi.fn(async () => ({}));
  const trigger = {
    scheduler: clock.scheduler,
    hints: { saveData: true },
    importMath,
    document: undefined,
    fonts: undefined,
  };
  warm.scheduleMathWarmup(trigger);
  expect(clock.pendingIdle).toBe(0);
  expect(clock.pendingTimers).toBe(0);
  warm.scheduleMathWarmup({ ...trigger, hints: {} });
  expect(clock.pendingIdle).toBe(1);
  clock.fireIdle();
  expect(importMath).toHaveBeenCalledTimes(1);
});
