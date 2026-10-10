import { expect, test } from "vitest";
import { PageMetrics } from "./page-metrics.ts";

test("reopening at the same bounds clears the viewport used while hidden", async () => {
  const metrics = new PageMetrics();
  let viewport = "pane";
  const show = () =>
    metrics.place("pane:1080x1040", async () => {
      viewport = "pane";
    });
  await show();
  await metrics.override(async () => {
    viewport = "680x660";
  });
  await show();
  expect(viewport).toBe("pane");
});

test("a hidden resize cannot finish after a newer visible placement", async () => {
  const metrics = new PageMetrics();
  let finish: (() => void) | undefined;
  let viewport = "hidden";
  const resized = metrics.override(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          viewport = "small";
          resolve();
        };
      }),
  );
  await Promise.resolve();
  await Promise.resolve();
  const shown = metrics.place("pane", async () => {
    viewport = "pane";
  });
  finish?.();
  await resized;
  await shown;
  expect(viewport).toBe("pane");
});

test("failed placement remains retryable at unchanged bounds", async () => {
  const metrics = new PageMetrics();
  await expect(
    metrics.place("pane", async () => {
      throw new Error("Unavailable");
    }),
  ).rejects.toThrow("Unavailable");
  let restored = false;
  await metrics.place("pane", async () => {
    restored = true;
  });
  expect(restored).toBe(true);
});
