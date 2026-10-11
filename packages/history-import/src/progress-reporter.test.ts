import { expect, test } from "vitest";
import { progressReporter } from "./progress-reporter.ts";

test("rapid scan inventories are batched while the final inventory is delivered immediately", () => {
  let now = 0;
  const shown: number[] = [];
  const progress = progressReporter(
    () => now,
    (files: number) => shown.push(files),
  );
  progress.update(1);
  now = 100;
  progress.update(2);
  now = 249;
  progress.update(3);
  expect(shown).toEqual([1]);
  now = 250;
  progress.update(4);
  now = 251;
  progress.update(5);
  progress.finish(6);
  expect(shown).toEqual([1, 4, 6]);
});
