import { expect, it } from "vitest";
import { harness, scheduled, start } from "./service-test-support.ts";
it("large jitter cannot skip later nominal occurrences", async () => {
  const h = harness();
  h.random = 0.99;
  const auto = scheduled("run_once", 600_000);
  if (auto.trigger.kind !== "schedule") throw new Error("Invalid test definition");
  auto.trigger.schedule.expression = "FREQ=MINUTELY;COUNT=3";
  h.service.put(auto);
  expect(h.timer.delay).toBe(60_000);
  h.now = start + 59_400;
  await h.timer.fire();
  await h.finish();
  expect(h.timer.delay).toBe(60_000);
  h.now = start + 119_400;
  await h.timer.fire();
  await h.finish(1);
  expect(h.inputs.map((input) => input.prompt)).toEqual([
    "Triage 2024-01-01T09:00:00.000Z",
    "Triage 2024-01-01T09:01:00.000Z",
  ]);
});
