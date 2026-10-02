import { expect, it } from "vitest";
import { harness, definition, start } from "./service-test-support.ts";
it("caps active executions across automations at 256", async () => {
  const h = harness();
  for (let i = 0; i < 9; i++) h.service.put(definition({ id: `job-${i}`, concurrency: 32 }));
  try {
    for (let i = 0; i < 256; i++)
      expect(
        h.service.trigger(`job-${Math.floor(i / 32)}`, {
          key: `event-${i}`,
          variables: { subject: "issues" },
        }).status,
      ).toBe("running");
    expect(
      h.service.trigger("job-8", { key: "overflow", variables: { subject: "issues" } }).status,
    ).toBe("skipped");
    expect(h.inputs).toHaveLength(256);
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
