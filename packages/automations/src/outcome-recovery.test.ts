import type { ExecutionResult } from "./index.ts";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { expect, test } from "vitest";
import { definition, deferred, harness } from "./service-test-support.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a refused recovery is retried until the thread outcome is observed, without executing again", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "refused", variables: { subject: "issues" } });
  h.deps.executor.recover = () => Promise.reject(new Error("workspace_change_in_progress"));
  h.restart();
  await h.service.settled();
  expect(h.errors.map(String)).toContain("Error: workspace_change_in_progress");
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  h.deps.executor.recover = () =>
    Promise.resolve({ threadId: "thread-0", status: "succeeded", result: "Recovered" });
  h.now = run.startedAt + 2 * 3_600_000;
  await h.timer.fire();
  await h.service.settled();
  expect(h.service.inbox().runs[0]).toMatchObject({ status: "succeeded", result: "Recovered" });
  expect(h.inputs).toHaveLength(1);
  expect(
    h.service.trigger("triage", { key: "next", variables: { subject: "issues" } }).status,
  ).toBe("running");
  await h.finish(1);
});

test("a successful outcome survives a failed SQLite completion write and is retried without duplicating work", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "finish", variables: { subject: "issues" } });
  const connection = new DatabaseSync(h.storePath);
  try {
    // Reject only the completion write at the real database boundary.
    connection.exec(
      "CREATE TRIGGER refuse_finish BEFORE UPDATE ON automation_runs BEGIN SELECT RAISE(ABORT, 'temporary completion failure'); END",
    );
    await h.finish();
    expect(h.service.inbox().runs[0]?.status).toBe("running");
    expect(h.errors.map(String).join(" ")).toContain("temporary completion failure");
    connection.exec("DROP TRIGGER refuse_finish");
    h.now = run.startedAt + 1000;
    await h.timer.fire();
    expect(h.service.inbox().runs[0]).toMatchObject({
      status: "succeeded",
      threadId: "thread-0",
      result: "Reviewed three issues",
    });
    expect(h.inputs).toHaveLength(1);
    expect(
      h.service.trigger("triage", { key: "next", variables: { subject: "issues" } }).status,
    ).toBe("running");
    await h.finish(1);
  } finally {
    connection.close();
  }
});

test("an outcome from an observer replaced during cancellation cannot finish the recovered run", async () => {
  const h = harness();
  const execute = h.deps.executor.execute;
  h.deps.executor.execute = (input, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        h.service.stop();
        h.service.start();
      },
      { once: true },
    );
    return execute(input, signal);
  };
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "replace", variables: { subject: "issues" } });
  const recovered = deferred<ExecutionResult>();
  h.recoveries.set(run.id, recovered.promise);
  h.completions[0]?.resolve({ threadId: "obsolete", status: "succeeded", result: "obsolete" });
  await turn();
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  recovered.resolve({ threadId: "recovered", status: "succeeded", result: "Current result" });
  await h.service.settled();
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "succeeded",
    threadId: "recovered",
    result: "Current result",
  });
});
