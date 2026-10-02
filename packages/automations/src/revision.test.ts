import { expect, it } from "vitest";
import { harness, definition, deferred, start } from "./service-test-support.ts";
import type { GhResponse } from "./index.ts";
const github = () =>
  definition({
    concurrency: 2,
    prompt: "Review {{number}}",
    trigger: {
      kind: "github",
      repository: "user/project",
      event: "pr_changed",
      pollIntervalMs: 60_000,
    },
  });
const resource = (id: number) => ({
  id,
  number: id,
  updated_at: "2024-01-02T00:00:00Z",
  html_url: `https://github.com/user/project/pull/${id}`,
  title: "Review",
});
it("stops an old GitHub batch when a run notification replaces its definition", async () => {
  let data: unknown = [];
  const h = harness({
    async get() {
      return { status: 200, etag: '"old"', next: undefined, data };
    },
  });
  h.service.put(github());
  await h.timer.fire();
  await h.service.settled();
  const normal = h.deps.onRun;
  h.deps.onRun = (run) => {
    normal(run);
    if (run.status === "running")
      h.service.put(definition({ concurrency: 2, prompt: "CHANGED {{number}}" }));
  };
  data = [resource(1), resource(2)];
  h.now = start;
  await h.timer.fire();
  for (const completion of h.completions)
    completion.resolve({ threadId: "thread", status: "succeeded", result: "done" });
  await h.service.settled();
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Review 1"]);
  expect(h.store.get("triage")?.state).toEqual({});
  expect(h.service.inbox().runs).toHaveLength(1);
});
it("rejects an in-flight poll response after a configuration revision changes", async () => {
  const response = deferred<GhResponse>();
  const h = harness({ get: () => response.promise });
  h.service.put(github());
  await h.timer.fire();
  h.service.put(definition({ concurrency: 2, prompt: "CHANGED {{number}}" }));
  response.resolve({ status: 200, etag: '"old"', next: undefined, data: [resource(1)] });
  await h.service.settled();
  expect(h.store.get("triage")?.state).toEqual({});
  expect(h.inputs).toEqual([]);
});
