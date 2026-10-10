import { expect, test } from "vitest";
import { definition, harness, scheduled, start } from "./service-test-support.ts";

test("a schedule catches up after the wall clock advances during sleep", async () => {
  const h = harness();
  h.service.put(scheduled("run_once"));
  h.now = start;
  await h.timer.fire();
  await h.finish();
  expect(h.timer.delay).toBe(60_000);
  h.now = start + 86_400_000 + 8 * 3_600_000;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(2);
  expect(h.inputs[1]?.prompt).toContain("2024-01-02T09:00:00.000Z");
  await h.finish(1);
});

test("an expired run releases its cap and late completion cannot rewrite the failure", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", { key: "stalled", variables: { subject: "first" } });
  h.now = start + 3_600_000;
  await h.timer.fire();
  await h.service.settled();
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "failed",
    result: "Automation exceeded its maximum runtime",
  });
  h.completions[0]?.resolve({ threadId: "late", status: "succeeded", result: "late" });
  expect(
    h.service.trigger("triage", { key: "next", variables: { subject: "second" } }).status,
  ).toBe("running");
  await h.finish(1);
  expect(h.service.inbox().runs.find((run) => run.eventKey === "stalled")?.status).toBe("failed");
});

test("restart expires an overdue running automation using its persisted start time", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", { key: "stalled", variables: { subject: "first" } });
  h.recoveries.set(first.id, new Promise(() => {}));
  h.now = start + 3_600_000;
  h.restart();
  await h.timer.fire();
  await h.service.settled();
  expect(h.service.inbox().runs[0]?.status).toBe("failed");
});

test("changes during a file automation's own run produce no new run or skipped history", async () => {
  const h = harness();
  h.service.put(
    definition({
      workspace: "/repo",
      prompt: "Review {{path}}",
      trigger: { kind: "file", paths: ["**/*.ts"] },
    }),
  );
  const receive = h.watches.get("/repo");
  if (!receive) throw new Error("Missing watcher");
  await receive({ key: "file:first", variables: { path: "first.ts" } });
  await receive({ key: "file:self", variables: { path: "own-edit.ts" } });
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs).toHaveLength(1);
  expect(
    h.service.trigger("triage", { key: "file:cap", variables: { path: "other.ts" } }, "file")
      .status,
  ).toBe("skipped");
  expect(h.service.inbox().runs).toHaveLength(1);
  await h.finish();
  await receive({ key: "file:after", variables: { path: "next.ts" } });
  expect(h.inputs).toHaveLength(2);
  await h.finish(1);
});

test("retention preserves the newest thousand results and unfinished work", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", { key: "running", variables: { subject: "running" } });
  for (let i = 0; i < 1010; i++)
    h.service.trigger("triage", { key: `skipped-${i}`, variables: { subject: "skipped" } });
  let page = h.service.inbox(100),
    count = page.runs.length;
  while (page.before !== null) {
    page = h.service.inbox(100, page.before);
    count += page.runs.length;
  }
  expect(count).toBe(1001);
  expect(h.store.active().map((entry) => entry.run.id)).toEqual([first.id]);
  await h.finish();
  page = h.service.inbox(100);
  count = page.runs.length;
  while (page.before !== null) {
    page = h.service.inbox(100, page.before);
    count += page.runs.length;
  }
  expect(count).toBe(1000);
});
