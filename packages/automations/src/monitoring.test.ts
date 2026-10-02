import { expect, it } from "vitest";
import { harness, definition, deferred } from "./service-test-support.ts";
import type { ExecutionResult } from "./index.ts";
it("releases obsolete executor monitoring subscriptions across repeated stop and start", async () => {
  const h = harness();
  const active = new Set<symbol>();
  const responses: ReturnType<typeof deferred<ExecutionResult>>[] = [];
  const watch = (signal?: AbortSignal) => {
    const token = Symbol();
    active.add(token);
    const response = deferred<ExecutionResult>();
    responses.push(response);
    signal?.addEventListener(
      "abort",
      () => {
        active.delete(token);
        response.resolve({ threadId: "obsolete", status: "succeeded", result: "obsolete" });
      },
      { once: true },
    );
    return response.promise;
  };
  h.deps.executor = {
    execute(_input, signal?: AbortSignal) {
      return watch(signal);
    },
    recover(_key, signal?: AbortSignal) {
      return watch(signal);
    },
  };
  try {
    h.service.put(definition());
    h.service.trigger("triage", { key: "once", variables: { subject: "issues" } });
    for (let i = 0; i < 20; i++) {
      h.service.stop();
      h.service.start();
    }
    expect(active.size).toBe(1);
    h.service.stop();
    expect(active.size).toBe(0);
    await h.service.settled();
    expect(h.service.inbox().runs).toMatchObject([{ status: "running" }]);
  } finally {
    for (const response of responses)
      response.resolve({ threadId: "cleanup", status: "succeeded", result: "cleanup" });
    h.service.stop();
  }
});
it("settles stopped monitors even when the executor ignores cancellation", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", { key: "pending", variables: { subject: "issues" } });
  h.service.stop();
  await h.service.settled();
  h.completions[0]?.resolve({ threadId: "late", status: "succeeded", result: "late" });
  h.service.start();
  await h.nextExecution(1);
  expect(h.service.inbox().runs).toMatchObject([{ status: "running", eventKey: "pending" }]);
  await h.finish(1);
  expect(h.service.inbox().runs).toMatchObject([{ status: "succeeded" }]);
});
it("does not launch a new observer after a run notification stops the service", async () => {
  const h = harness();
  h.service.put(definition());
  h.deps.onRun = (run) => {
    if (run.status === "running") h.service.stop();
  };
  h.service.trigger("triage", {
    key: "stop-during-notification",
    variables: { subject: "issues" },
  });
  expect(h.inputs).toEqual([]);
  expect(h.service.inbox().runs).toMatchObject([{ status: "running" }]);
  h.service.start();
  await h.nextExecution(0);
  await h.finish();
  expect(h.service.inbox().runs).toMatchObject([{ status: "succeeded" }]);
});
