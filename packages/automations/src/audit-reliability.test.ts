import { expect, test } from "vitest";
import type { ExecutionResult } from "./index.ts";
import { definition, deferred, harness, scheduled, start } from "./service-test-support.ts";

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

test("an automation run longer than an hour stays running while its thread works", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "long", variables: { subject: "first" } });
  h.now = run.startedAt + 6 * 3_600_000;
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  expect(
    h.service.trigger("triage", { key: "blocked", variables: { subject: "second" } }).status,
  ).toBe("queued");
  h.completions[0]?.resolve({ threadId: "thread-0", status: "succeeded", result: "Done" });
  await waitFor(() => h.completions[1]);
  expect(h.service.inbox().runs.find((item) => item.eventKey === "long")).toMatchObject({
    status: "succeeded",
    threadId: "thread-0",
  });
  await h.finish(1);
});

test("restart keeps observing a running automation started hours earlier", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", { key: "long", variables: { subject: "first" } });
  const recovered = deferred<ExecutionResult>();
  h.recoveries.set(first.id, recovered.promise);
  h.now = start + 5 * 3_600_000;
  h.restart();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  recovered.resolve({ threadId: "thread-long", status: "succeeded", result: "Done" });
  await h.service.settled();
  expect(h.service.inbox().runs[0]).toMatchObject({ status: "succeeded", result: "Done" });
  expect(h.inputs).toHaveLength(1);
});

test("a file automation's own edits during its run start no new run and leave no history", async () => {
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
  // The run edits files as it works: each edit is a change the watcher sees.
  for (const edit of ["one.ts", "two.ts", "three.ts"])
    await receive({ key: `file:self:${edit}`, variables: { path: edit } });
  expect(
    h.service.trigger("triage", { key: "file:direct", variables: { path: "other.ts" } }, "file")
      .status,
  ).toBe("skipped");
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs.map((run) => run.status)).toEqual(["running"]);
  await h.finish();
  // Nothing was waiting behind the run, so it never starts itself again.
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs.map((run) => run.status)).toEqual(["succeeded"]);
  // A change after the run is a new one.
  await receive({ key: "file:after", variables: { path: "next.ts" } });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Review first.ts", "Review next.ts"]);
  await h.finish(1);
});

test("a manual run while a file automation works still waits for it", async () => {
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
  expect(
    h.service.trigger("triage", { key: "manual", variables: { path: "asked.ts" } }).status,
  ).toBe("queued");
  await receive({ key: "file:during", variables: { path: "own-edit.ts" } });
  expect(h.service.inbox().runs.map((run) => run.status)).toEqual(["queued", "running"]);
  h.completions[0]?.resolve({ threadId: "thread-0", status: "succeeded", result: "Done" });
  await waitFor(() => h.completions[1]);
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Review first.ts", "Review asked.ts"]);
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
  // The newest thousand finished runs, plus the one running and the one waiting behind it.
  expect(count).toBe(1002);
  expect(h.store.active().map((entry) => entry.run.id)).toEqual([first.id]);
  h.completions[0]?.resolve({ threadId: "thread-0", status: "succeeded", result: "Done" });
  await waitFor(() => h.completions[1]);
  await h.finish(1);
  page = h.service.inbox(100);
  count = page.runs.length;
  while (page.before !== null) {
    page = h.service.inbox(100, page.before);
    count += page.runs.length;
  }
  expect(count).toBe(1000);
});

/** Waits for the service to start the next run, which it does after the previous settles. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting");
}
