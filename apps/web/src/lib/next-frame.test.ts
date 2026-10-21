import { expect, test, vi, afterEach } from "vitest";
import { frameBatch } from "@ace/client-react";
import { nextFrame } from "./next-frame.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a queued update reaches a tab that becomes hidden before its next paint", async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const batch = frameBatch(nextFrame);
  let title = "ace";
  batch.schedule(() => {
    title = "(1) ace";
  });
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(100);
  expect(title).toBe("(1) ace");
});

test("a queued update reaches a window that reports itself visible but is never painted", async () => {
  vi.useFakeTimers();
  // Safari on another Space: visible to the page, yet no animation frame ever comes.
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const batch = frameBatch(nextFrame);
  let title = "ace";
  batch.schedule(() => {
    title = "(1) ace";
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(title).toBe("(1) ace");
});

test("a painted frame runs the work once, and the timer doesn't run it again", async () => {
  vi.useFakeTimers();
  let paint: FrameRequestCallback | undefined;
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    paint = callback;
    return 1;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let runs = 0;
  nextFrame(() => runs++);
  paint?.(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(runs).toBe(1);
});
