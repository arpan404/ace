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
