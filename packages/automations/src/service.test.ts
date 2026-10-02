import { expect, it } from "vitest";
import { harness, definition, scheduled, start, deferred } from "./service-test-support.ts";
import type { ExecutionResult } from "./index.ts";

it("fills trigger variables and persists a successful result with its thread", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", {
    key: "manual:1",
    variables: { subject: "new issues" },
  });
  expect(run.status).toBe("running");
  expect(h.inputs).toEqual([
    {
      idempotencyKey: run.id,
      automationId: "triage",
      provider: "codex",
      model: "test-model",
      workspace: "/project",
      prompt: "Triage new issues",
      worktree: true,
    },
  ]);
  await h.finish();
  h.restart();
  expect(h.service.inbox().runs).toEqual([
    expect.objectContaining({
      status: "succeeded",
      threadId: "thread-0",
      result: "Reviewed three issues",
      finishedAt: start - 60_000,
    }),
  ]);
});
it("deduplicates repeated events even after restart", async () => {
  const h = harness();
  h.service.put(definition());
  const event = { key: "github:42:v1", variables: { subject: "CI failure" } };
  const run = h.service.trigger("triage", event, "github");
  await h.finish();
  h.restart();
  expect(h.service.trigger("triage", event, "github").id).toBe(run.id);
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs).toHaveLength(1);
});
it("keeps concurrency occupied while an executor waits for a human", async () => {
  const h = harness();
  h.service.put(definition({ concurrency: 2 }));
  for (let i = 0; i < 3; i++)
    h.service.trigger("triage", { key: `event-${i}`, variables: { subject: "review" } });
  expect(h.inputs).toHaveLength(2);
  expect(h.service.inbox().runs.map((r) => r.status)).toEqual(["skipped", "running", "running"]);
  h.completions[0]?.resolve({ threadId: "one", status: "succeeded", result: "done" });
  h.completions[1]?.resolve({ threadId: "two", status: "succeeded", result: "done" });
  await h.service.settled();
  expect(
    h.service.trigger("triage", { key: "event-3", variables: { subject: "review" } }).status,
  ).toBe("running");
  await h.finish(2);
});
it("records a missing template variable as failure without creating a thread", () => {
  const h = harness();
  h.service.put(definition());
  expect(h.service.trigger("triage", { key: "missing", variables: {} })).toMatchObject({
    status: "failed",
    result: "Missing trigger variable: subject",
  });
  expect(h.inputs).toHaveLength(0);
});
it("records executor failures rather than treating acceptance as completion", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", { key: "failure", variables: { subject: "issues" } });
  await h.finish(0, "failed");
  expect(h.service.inbox().runs[0]).toMatchObject({
    status: "failed",
    result: "Reviewed three issues",
  });
});
it("skip discards all downtime occurrences and waits for the next future run", async () => {
  const h = harness();
  h.service.put(scheduled("skip"));
  h.now = start + 3 * 86_400_000 + 3_600_000;
  h.restart();
  expect(h.timer.delay).toBe(23 * 3_600_000);
  expect(h.inputs).toHaveLength(0);
  h.now = start + 4 * 86_400_000;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]?.prompt).toBe("Triage 2024-01-05T09:00:00.000Z");
  await h.finish();
});
it("run_once coalesces downtime into one run and advances beyond now", async () => {
  const h = harness();
  h.service.put(scheduled("run_once"));
  h.now = start + 3 * 86_400_000 + 3_600_000;
  h.restart();
  expect(h.timer.delay).toBe(0);
  await h.timer.fire();
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]?.prompt).toBe("Triage 2024-01-01T09:00:00.000Z");
  expect(h.timer.delay).toBe(23 * 3_600_000);
  await h.finish();
});
it("jitter survives restart and never runs before its persisted deadline", async () => {
  const h = harness();
  h.random = 0.5;
  h.service.put(scheduled("skip", 10_000));
  expect(h.timer.delay).toBe(65_000);
  h.now = start + 1000;
  h.random = 0.9;
  h.restart();
  expect(h.timer.delay).toBe(4000);
  await h.timer.fire();
  expect(h.inputs).toHaveLength(0);
  expect(h.timer.delay).toBe(4000);
  h.now = start + 5000;
  await h.timer.fire();
  expect(h.inputs).toHaveLength(1);
  await h.finish();
});
it("arms one timer for the earliest job and cancels it when schedules are removed", async () => {
  const h = harness();
  h.service.put(scheduled());
  h.service.put({
    ...scheduled(),
    id: "later",
    trigger: {
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 10 * * *", timezone: "UTC", startAt: start },
    },
  });
  expect(h.timer.maximum).toBe(1);
  expect(h.timer.active.size).toBe(1);
  expect(h.timer.delay).toBe(60_000);
  h.service.remove("triage");
  expect(h.timer.delay).toBe(3_660_000);
  h.service.remove("later");
  expect(h.timer.active.size).toBe(0);
  await h.service.settled();
});
it("rearms platform-sized long delays and ignores early timer wakes", async () => {
  const h = harness();
  h.service.put({
    ...scheduled(),
    trigger: {
      kind: "schedule",
      schedule: {
        kind: "rrule",
        expression: "FREQ=YEARLY",
        timezone: "UTC",
        startAt: start + 365 * 86_400_000,
      },
    },
  });
  expect(h.timer.delay).toBe(2_147_483_647);
  await h.timer.fire();
  expect(h.inputs).toHaveLength(0);
  expect(h.timer.active.size).toBe(1);
});
it("reconciles a running thread after restart before admitting more work", async () => {
  const h = harness();
  h.service.put(definition());
  const first = h.service.trigger("triage", { key: "first", variables: { subject: "issues" } });
  const recovery = deferred<ExecutionResult | undefined>();
  h.recoveries.set(first.id, recovery.promise);
  h.restart();
  expect(
    h.service.trigger("triage", { key: "second", variables: { subject: "issues" } }).status,
  ).toBe("skipped");
  expect(h.inputs).toHaveLength(1);
  recovery.resolve({ threadId: "recovered", status: "succeeded", result: "Recovered completion" });
  await h.service.settled();
  expect(h.service.inbox().runs.find((r) => r.id === first.id)).toMatchObject({
    status: "succeeded",
    threadId: "recovered",
  });
  h.completions[0]?.resolve({ threadId: "obsolete", status: "failed", result: "late" });
});
it("retries creation with the same idempotency key when a crash preceded thread creation", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "crash", variables: { subject: "issues" } });
  h.restart();
  await h.nextExecution(1);
  expect(h.inputs.map((i) => i.idempotencyKey)).toEqual([run.id, run.id]);
  await h.finish(1);
  h.completions[0]?.resolve({ threadId: "old", status: "succeeded", result: "old" });
});
it("pages the scheduled inbox without repeating rows", () => {
  const h = harness();
  h.service.put(definition());
  for (let i = 0; i < 5; i++) h.service.trigger("triage", { key: `bad-${i}`, variables: {} });
  const first = h.service.inbox(2);
  expect(first.runs.map((r) => r.eventKey)).toEqual(["bad-4", "bad-3"]);
  expect(first.before).not.toBeNull();
  const second = h.service.inbox(2, first.before ?? undefined);
  expect(second.runs.map((r) => r.eventKey)).toEqual(["bad-2", "bad-1"]);
  expect(h.service.inbox(2, second.before ?? undefined)).toMatchObject({
    runs: [expect.objectContaining({ eventKey: "bad-0" })],
    before: null,
  });
});
it("subscribes file changes through the workspace contract and deduplicates delivery", async () => {
  const h = harness();
  h.service.put(definition({ trigger: { kind: "file", paths: ["src/**"] } }));
  const receive = h.watches.get("/project");
  expect(receive).toBeDefined();
  await receive?.({ key: "change:1", variables: { subject: "src/main.ts" } });
  await receive?.({ key: "change:1", variables: { subject: "src/main.ts" } });
  expect(h.inputs).toHaveLength(1);
  expect(h.service.inbox().runs[0]?.trigger).toBe("file");
  await h.finish();
  h.service.remove("triage");
  expect(h.watches.size).toBe(0);
});
it("manual wire requests reuse their request ID as a durable event key", async () => {
  const h = harness();
  h.service.handle({ type: "automation.put", requestId: "config", automation: definition() });
  const request = {
    type: "automation.run",
    requestId: "run-now",
    id: "triage",
    variables: { subject: "issues" },
  };
  expect(h.service.handle(request).run?.status).toBe("running");
  expect(h.service.handle(request).ok).toBe(true);
  expect(h.inputs).toHaveLength(1);
  await h.finish();
  h.service.put(definition({ enabled: false }));
  expect(h.service.handle({ ...request, requestId: "disabled" })).toMatchObject({ ok: false });
});
it("persists COUNT progress and stops at the limit after a restart", async () => {
  const h = harness();
  const auto = scheduled("run_once");
  if (auto.trigger.kind !== "schedule") throw new Error("Invalid test definition");
  auto.trigger.schedule.expression = "FREQ=DAILY;COUNT=3";
  h.service.put(auto);
  h.now = start;
  await h.timer.fire();
  await h.finish();
  h.restart();
  h.now = start + 86_400_000;
  await h.timer.fire();
  await h.finish(1);
  h.now = start + 2 * 86_400_000;
  await h.timer.fire();
  await h.finish(2);
  expect(h.inputs).toHaveLength(3);
  expect(h.timer.active.size).toBe(0);
  h.restart();
  expect(h.timer.active.size).toBe(0);
});
it("counts skipped downtime occurrences toward COUNT", () => {
  const h = harness();
  const auto = scheduled("skip");
  if (auto.trigger.kind !== "schedule") throw new Error("Invalid test definition");
  auto.trigger.schedule.expression = "FREQ=DAILY;COUNT=3";
  h.service.put(auto);
  h.now = start + 5 * 86_400_000;
  h.restart();
  expect(h.timer.active.size).toBe(0);
  expect(h.service.inbox().runs).toHaveLength(0);
});
it("preserves a running record and its slot when recovery is uncertain", async () => {
  const h = harness();
  h.service.put(definition());
  const run = h.service.trigger("triage", { key: "first", variables: { subject: "issues" } });
  h.recoveries.set(run.id, Promise.reject(new Error("Engine unavailable")));
  h.restart();
  await h.service.settled();
  expect(h.service.inbox().runs[0]?.status).toBe("running");
  expect(
    h.service.trigger("triage", { key: "second", variables: { subject: "issues" } }).status,
  ).toBe("skipped");
  expect(h.errors).toEqual([expect.objectContaining({ message: "Engine unavailable" })]);
  h.completions[0]?.resolve({ threadId: "old", status: "succeeded", result: "old" });
});
it("retains each automation's own concurrency limit", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.put(definition({ id: "other" }));
  h.service.trigger("triage", { key: "1", variables: { subject: "issues" } });
  expect(h.service.trigger("other", { key: "1", variables: { subject: "issues" } }).status).toBe(
    "running",
  );
  h.completions[0]?.resolve({ threadId: "a", status: "succeeded", result: "done" });
  await h.finish(1);
});
it("retrying an unchanged put preserves jitter and counted progress", async () => {
  const h = harness();
  h.random = 0.5;
  const auto = scheduled("run_once", 10_000);
  h.service.put(auto);
  h.random = 0.9;
  h.service.put(auto);
  expect(h.timer.delay).toBe(65_000);
  h.now = start + 5000;
  await h.timer.fire();
  await h.finish();
  h.service.put(auto);
  expect(h.timer.delay).toBe(86_404_000);
});
it("repeated event delivery does not republish run notifications", async () => {
  const h = harness();
  h.service.put(definition());
  const event = { key: "same", variables: { subject: "issues" } };
  h.service.trigger("triage", event);
  h.service.trigger("triage", event);
  await h.finish();
  h.service.trigger("triage", event);
  expect(h.changes.map((run) => run.status)).toEqual(["running", "succeeded"]);
});
it("dispatches scheduled work while a GitHub request is still pending", async () => {
  const response = deferred<import("./index.ts").GhResponse>();
  const h = harness({ get: () => response.promise });
  h.service.put(
    definition({
      id: "github",
      trigger: {
        kind: "github",
        repository: "user/project",
        event: "pr_changed",
        pollIntervalMs: 60_000,
      },
    }),
  );
  h.service.put(scheduled());
  await h.timer.fire();
  expect(h.timer.delay).toBe(60_000);
  h.now = start;
  await h.timer.fire();
  expect(h.inputs[0]?.prompt).toBe("Triage 2024-01-01T09:00:00.000Z");
  response.resolve({ status: 200, etag: undefined, next: undefined, data: [] });
  await h.finish();
  expect(h.timer.maximum).toBe(1);
});
it("bounds GitHub processes and resumes queued sources when requests complete", async () => {
  const responses: ReturnType<typeof deferred<import("./index.ts").GhResponse>>[] = [];
  const h = harness({
    get() {
      const response = deferred<import("./index.ts").GhResponse>();
      responses.push(response);
      return response.promise;
    },
  });
  for (let i = 0; i < 5; i++)
    h.service.put(
      definition({
        id: `github-${i}`,
        trigger: {
          kind: "github",
          repository: "user/project",
          event: "pr_changed",
          pollIntervalMs: 60_000,
        },
      }),
    );
  await h.timer.fire();
  expect(responses).toHaveLength(4);
  expect(h.timer.active.size).toBe(0);
  for (const response of responses)
    response.resolve({ status: 200, etag: undefined, next: undefined, data: [] });
  await h.service.settled();
  expect(h.timer.delay).toBe(0);
  await h.timer.fire();
  expect(responses).toHaveLength(5);
  responses[4]?.resolve({ status: 200, etag: undefined, next: undefined, data: [] });
  await h.service.settled();
  expect(h.timer.maximum).toBe(1);
});
it("records oversized rendered prompts without invoking the executor", () => {
  const h = harness();
  h.service.put(definition({ prompt: "{{subject}}".repeat(9) }));
  expect(
    h.service.trigger("triage", { key: "too-large", variables: { subject: "x".repeat(8192) } }),
  ).toMatchObject({ status: "failed", result: "Rendered prompt exceeds limit" });
  expect(h.inputs).toHaveLength(0);
});
it("treats trigger text as literal content rather than another template", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", {
    key: "literal",
    variables: { subject: "{{other}} $(not-a-command)" },
  });
  expect(h.inputs[0]?.prompt).toBe("Triage {{other}} $(not-a-command)");
  await h.finish();
});
