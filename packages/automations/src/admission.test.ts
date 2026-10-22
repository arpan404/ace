import { expect, it } from "vitest";
import { harness, definition, start } from "./service-test-support.ts";
it("caps active executions across automations at 256", async () => {
  const h = harness();
  for (let i = 0; i < 257; i++) h.service.put(definition({ id: `job-${i}` }));
  try {
    for (let i = 0; i < 256; i++)
      expect(
        h.service.trigger(`job-${i}`, { key: "event", variables: { subject: "issues" } }).status,
      ).toBe("running");
    expect(
      h.service.trigger("job-256", { key: "overflow", variables: { subject: "issues" } }).status,
    ).toBe("skipped");
    expect(h.inputs).toHaveLength(256);
  } finally {
    for (const completion of h.completions)
      completion.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await h.service.settled();
  }
});
it("a waiting run held by the running limit starts once room frees anywhere", async () => {
  const h = harness();
  for (let i = 0; i < 257; i++) h.service.put(definition({ id: `job-${i}` }));
  try {
    h.service.trigger("job-0", { key: "first", variables: { subject: "first" } });
    expect(
      h.service.trigger("job-0", { key: "second", variables: { subject: "second" } }).status,
    ).toBe("queued");
    for (let i = 1; i < 256; i++)
      h.service.trigger(`job-${i}`, { key: "event", variables: { subject: "issues" } });
    expect(h.inputs).toHaveLength(256);
    // job-0's own run ends while ace is still full: its waiting run starts in the room it left.
    h.completions[0]?.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    expect((await h.nextExecution(256)).prompt).toBe("Triage second");
    expect(h.store.active()).toHaveLength(256);
  } finally {
    for (const completion of h.completions)
      completion.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await h.service.settled();
  }
});
it("a waiting run never starts past the running limit, and starts when another run frees room", async () => {
  const h = harness();
  for (let i = 0; i < 257; i++) h.service.put(definition({ id: `job-${i}` }));
  try {
    h.service.trigger("job-0", { key: "first", variables: { subject: "first" } });
    h.service.trigger("job-0", { key: "second", variables: { subject: "second" } });
    for (let i = 1; i < 256; i++)
      h.service.trigger(`job-${i}`, { key: "event", variables: { subject: "issues" } });
    // Another automation fires in the moment job-0's run ends, taking the room it left.
    const published = h.deps.onRun;
    h.deps.onRun = (run) => {
      published?.(run);
      if (run.automationId === "job-0" && run.status === "succeeded")
        h.service.trigger("job-256", { key: "event", variables: { subject: "late" } });
    };
    h.completions[0]?.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await expect.poll(() => h.inputs.at(-1)?.prompt).toBe("Triage late");
    expect(h.store.active()).toHaveLength(256);
    expect(h.inputs.some((input) => input.prompt === "Triage second")).toBe(false);
    // Another automation's run ends: the waiting one takes its room, never more.
    h.completions[100]?.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await expect.poll(() => h.inputs.at(-1)?.prompt).toBe("Triage second");
    expect(h.store.active()).toHaveLength(256);
  } finally {
    for (const completion of h.completions)
      completion.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await h.service.settled();
  }
});
it("rejects invalid trigger keys before recording or executing a run", () => {
  const h = harness();
  h.service.put(definition());
  expect(() =>
    h.service.trigger("triage", { key: "", variables: { subject: "issues" } }),
  ).toThrow();
  expect(h.service.inbox().runs).toEqual([]);
  expect(h.inputs).toEqual([]);
});
it("preserves a committed GitHub cursor when the next response is malformed", async () => {
  let data: unknown = [];
  let etag = '"good"';
  const sent: (string | undefined)[] = [];
  const h = harness({
    async get(_endpoint, cursor) {
      sent.push(cursor);
      return { status: 200, etag, next: undefined, data };
    },
  });
  h.service.put(
    definition({
      trigger: {
        kind: "github",
        repository: "user/project",
        event: "pr_changed",
        pollIntervalMs: 60_000,
      },
    }),
  );
  await h.timer.fire();
  await h.service.settled();
  const state = h.store.get("triage")?.state;
  data = [{ id: "invalid" }];
  etag = '"bad"';
  h.now = start;
  await h.timer.fire();
  await h.service.settled();
  expect(h.errors).toHaveLength(1);
  expect(h.store.get("triage")?.state).toEqual(state);
  h.restart();
  h.now = start + 60_000;
  data = [];
  await h.timer.fire();
  await h.service.settled();
  expect(sent).toEqual([undefined, '"good"', '"good"']);
  expect(h.service.inbox().runs).toEqual([]);
});
it("an execution carries the automation's name, so its thread is named after it, not its id", async () => {
  const h = harness();
  h.service.put(definition({ title: "Nightly triage" }));
  try {
    h.service.trigger("triage", { key: "named", variables: { subject: "issues" } });
    expect(h.inputs.map((input) => input.title)).toEqual(["Nightly triage"]);
  } finally {
    for (const completion of h.completions)
      completion.resolve({ threadId: "thread", status: "succeeded", result: "done" });
    await h.service.settled();
  }
});
