import { expect, test } from "vitest";
import { definition, harness, scheduled, start } from "./service-test-support.ts";

const subject = (key: string) => ({ key, variables: { subject: key } });

test("a run fired while the last one works waits, then starts when it finishes", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", subject("first"));
  expect(h.service.trigger("triage", subject("second")).status).toBe("queued");
  // One waiting is enough: a third fire meanwhile is skipped, not stacked behind it.
  expect(h.service.trigger("triage", subject("third"))).toMatchObject({
    status: "skipped",
    result: "A run was already waiting",
  });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage first"]);
  h.completions[0]?.resolve({ threadId: "thread", status: "succeeded", result: "Done" });
  expect((await h.nextExecution(1)).prompt).toBe("Triage second");
  expect(h.service.inbox().runs.map((run) => [run.eventKey, run.status])).toEqual([
    ["third", "skipped"],
    ["second", "running"],
    ["first", "succeeded"],
  ]);
  await h.finish(1);
});

test("a waiting run survives a restart and starts after the run it waited for", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", subject("first"));
  h.service.trigger("triage", subject("second"));
  let settle: ((value: undefined) => void) | undefined;
  h.recoveries.set(
    first.id,
    new Promise((resolve) => {
      settle = resolve;
    }).then(() => ({ threadId: "thread", status: "succeeded" as const, result: "Done" })),
  );
  h.restart();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs[0]?.status).toBe("queued");
  settle?.(undefined);
  expect((await h.nextExecution(1)).prompt).toBe("Triage second");
  await h.finish(1);
});

test("pausing skips the waiting run and stops the one in progress", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", subject("first"));
  h.service.trigger("triage", subject("second"));
  h.service.setEnabled("triage", false);
  await h.service.settled();
  expect(h.interrupts.map((input) => input.prompt)).toEqual(["Triage first"]);
  expect(h.service.inbox().runs.map((run) => [run.eventKey, run.status, run.result])).toEqual([
    ["second", "skipped", "Paused before it started"],
    ["first", "failed", "Stopped before it finished."],
  ]);
  expect(h.inputs).toHaveLength(1);
});

test("deleting an automation stops its work the same way", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", subject("first"));
  h.service.trigger("triage", subject("second"));
  h.service.remove("triage");
  await h.service.settled();
  expect(h.interrupts).toHaveLength(1);
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "skipped",
    result: "Deleted before it started",
  });
});

test("a schedule set to skip missed runs skips one the computer slept through", async () => {
  const h = harness();
  h.service.put(scheduled("skip"));
  // Asleep from before 9:00 until noon, with ace still running.
  h.now = start + 3 * 3_600_000;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(0);
  expect(h.service.inbox().runs).toHaveLength(0);
  // The next day's run is still on.
  h.now = start + 86_400_000;
  await h.timer.fire();
  expect(h.inputs.map((input) => input.prompt)).toEqual([
    `Triage ${new Date(start + 86_400_000).toISOString()}`,
  ]);
  await h.finish(0);
});

test("a schedule set to run missed runs once runs the one it slept through, once", async () => {
  const h = harness();
  h.service.put(scheduled("run_once"));
  h.now = start + 3 * 3_600_000;
  await h.timer.fire();
  expect(h.inputs.map((input) => input.prompt)).toEqual([
    `Triage ${new Date(start).toISOString()}`,
  ]);
  await h.finish(0);
});

test("a run that is only a little late is still on time", async () => {
  const h = harness();
  h.service.put(scheduled("skip"));
  h.now = start + 30_000;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(1);
  await h.finish(0);
});
