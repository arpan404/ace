import { expect, test } from "vitest";
import { previousGroupsGone } from "./cursor-process-check.ts";

function manualClock() {
  let now = 0;
  return { now: () => now, wait: async (ms: number) => void (now += ms) };
}

test("the previous run's groups count as gone once a pass ends and proves nothing more", async () => {
  let passes = 3;
  const record = { recover: () => ({ killed: passes-- > 0 ? 1 : 0 }) };
  await expect(previousGroupsGone(record, 1_000, manualClock())).resolves.toBe(true);
});

test("a group still alive, or unproven, at the bound is not gone", async () => {
  await expect(
    previousGroupsGone({ recover: () => ({ killed: 1 }) }, 500, manualClock()),
  ).resolves.toBe(false);
  await expect(
    previousGroupsGone({ recover: () => ({ killed: 0, unresolved: 1 }) }, 500, manualClock()),
  ).resolves.toBe(false);
});

test("a record that can't be read proves nothing gone", async () => {
  const record = {
    recover: (): { killed: number } => {
      throw new Error("database is locked");
    },
  };
  await expect(previousGroupsGone(record, 500, manualClock())).resolves.toBe(false);
});
