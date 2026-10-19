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

test("idle work runs when the page is idle and can be cancelled", () => {
  const scheduled = new Map<number, () => void>();
  let next = 0;
  const scheduler: IdleScheduler = {
    requestIdleCallback: (work) => {
      const id = ++next;
      scheduled.set(id, work);
      return id;
    },
    cancelIdle: (id) => void scheduled.delete(id),
    setTimeout: (work) => setTimeout(work, 0),
    clearTimeout: (id) => clearTimeout(id),
  };
  const work = vi.fn();
  const cancel = scheduleWhenIdle(scheduler, work, 3000);
  expect(work).not.toHaveBeenCalled();
  scheduled.get(1)?.();
  expect(work).toHaveBeenCalledTimes(1);
  cancel();
  expect(scheduled.has(1)).toBe(false);
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
