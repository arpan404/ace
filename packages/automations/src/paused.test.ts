import { expect, it } from "vitest";
import { harness, definition, scheduled, start } from "./service-test-support.ts";
import { pausedRefusal, pausedResult } from "./index.ts";

const day = 86_400_000;
const history = (h: ReturnType<typeof harness>) =>
  h.service.inbox(50, undefined, "triage").runs.map((run) => ({
    status: run.status,
    result: run.result,
  }));

it("a schedule due while new work is paused is skipped, then runs at its next time after resume", async () => {
  const h = harness();
  h.service.put(scheduled("skip"));
  h.pause();
  h.now = start;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(0);
  expect(history(h)).toEqual([{ status: "skipped", result: pausedResult }]);
  // It moved on to tomorrow rather than waiting for the resume.
  expect(h.service.handle({ type: "automation.list", requestId: "list" })).toMatchObject({
    schedules: [{ nextRunAt: start + day }],
  });

  h.resume();
  expect(h.inputs).toHaveLength(0);
  h.now = start + day;
  await h.timer.fire();
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage 2024-01-02T09:00:00.000Z"]);
  await h.finish();
  expect(history(h).map((run) => run.status)).toEqual(["succeeded", "skipped"]);
});

it("Run now while new work is paused is refused and starts nothing", async () => {
  const h = harness();
  h.service.put(definition());
  h.pause();
  const response = h.service.handle({
    type: "automation.run",
    requestId: "now",
    id: "triage",
    variables: { subject: "bugs" },
  });
  expect(response).toMatchObject({ ok: false, error: pausedRefusal });
  await h.service.settled();
  expect(h.inputs).toHaveLength(0);
  expect(history(h)).toEqual([]);

  h.resume();
  h.service.trigger("triage", { key: "after", variables: { subject: "bugs" } });
  expect(h.inputs).toHaveLength(1);
  await h.finish();
});

it("a run waiting behind one still going stays waiting while paused, and starts on resume", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", { key: "first", variables: { subject: "one" } });
  h.service.trigger("triage", { key: "second", variables: { subject: "two" } });
  h.pause();
  await h.finish(0);
  expect(h.inputs).toHaveLength(1);
  expect(history(h).map((run) => run.status)).toEqual(["queued", "succeeded"]);

  h.resume();
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage one", "Triage two"]);
  await h.finish(1);
});
