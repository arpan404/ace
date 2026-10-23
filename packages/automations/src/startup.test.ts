import { expect, it } from "vitest";
import { definition, deferred, harness, scheduled, start } from "./service-test-support.ts";
import type { AutomationEvent, AutomationResponse } from "@ace/protocol";
import type { ExecutionResult } from "./index.ts";

it("rejects admission immediately when a subscription stops startup", () => {
  const h = harness();
  h.service.stop();
  h.service.put(definition({ id: "a-watch", trigger: { kind: "file", paths: ["src/**"] } }));
  h.service.put(definition({ id: "b-watch", trigger: { kind: "file", paths: ["test/**"] } }));
  h.service.put(definition());
  const active = new Set<string>();
  const installed: string[] = [];
  let response: AutomationResponse | undefined;
  h.deps.workspace = {
    subscribe(_root, paths) {
      installed.push(paths[0] ?? "missing");
      active.add(paths[0] ?? "missing");
      h.service.stop();
      response = h.service.handle({
        type: "automation.run",
        requestId: "during-startup-stop",
        id: "triage",
        variables: { subject: "issues" },
      });
      return () => {
        active.clear();
      };
    },
  };
  h.service.start();
  expect(response).toMatchObject({ ok: false, error: "Automation service is stopped" });
  expect(h.service.inbox().runs).toEqual([]);
  expect(h.inputs).toEqual([]);
  expect(installed).toEqual(["src/**"]);
  expect(active.size).toBe(0);
});

it("isolates a failed startup watcher while keeping healthy schedules and recovery usable", async () => {
  const h = harness();
  h.service.stop();
  const first = definition({
    id: "a-watch",
    workspace: "/first",
    trigger: { kind: "file", paths: ["src/**"] },
  });
  const second = definition({
    id: "b-watch",
    workspace: "/second",
    trigger: { kind: "file", paths: ["test/**"] },
  });
  h.service.put(first);
  h.service.put(second);
  const active = new Map<
    symbol,
    { root: string; receive: (event: AutomationEvent) => Promise<void> }
  >();
  let fail = true;
  h.deps.workspace = {
    subscribe(root, _paths, receive, hooks) {
      if (root === "/second" && fail) {
        throw new Error("second subscription failed");
      }
      const token = Symbol();
      active.set(token, { root, receive });
      hooks?.onReady?.();
      return () => {
        active.delete(token);
      };
    },
  };
  // One stale workspace no longer aborts the scheduler: the healthy watcher
  // installs, the failed trigger persists with health, and definitions survive.
  h.service.start();
  expect([...active.values()].map((watch) => watch.root)).toEqual(["/first"]);
  expect(h.service.list()).toEqual([first, second]);
  const schedules = h.service.handle({ type: "automation.list", requestId: "health" }).schedules;
  expect(schedules?.find((entry) => entry.id === "b-watch")?.triggerError?.message).toBe(
    "second subscription failed",
  );
  expect(schedules?.find((entry) => entry.id === "a-watch")?.triggerError).toBeUndefined();
  // The healthy watcher still delivers while the failed one waits for retry.
  const healthy = [...active.values()].find((watch) => watch.root === "/first");
  if (!healthy) throw new Error("Missing healthy watcher");
  await healthy.receive({ key: "healthy-0", variables: { subject: "file-0.ts" } });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage file-0.ts"]);
  await h.finish(0);
  // An explicit retry reinitializes the failed trigger and clears health only on success.
  expect(
    h.service.handle({ type: "automation.retry", requestId: "retry-fail", id: "b-watch" }),
  ).toMatchObject({ ok: false });
  expect(
    h.service
      .handle({ type: "automation.list", requestId: "still-broken" })
      .schedules?.find((entry) => entry.id === "b-watch")?.triggerError?.message,
  ).toBe("second subscription failed");
  fail = false;
  expect(
    h.service.handle({ type: "automation.retry", requestId: "retry-ok", id: "b-watch" }),
  ).toMatchObject({ ok: true });
  expect([...active.values()].map((watch) => watch.root).toSorted()).toEqual(["/first", "/second"]);
  expect(
    h.service
      .handle({ type: "automation.list", requestId: "healthy" })
      .schedules?.find((entry) => entry.id === "b-watch")?.triggerError,
  ).toBeUndefined();
  for (const [index, watch] of [...active.values()].entries())
    await watch.receive({ key: `retry-${index}`, variables: { subject: `file-${index}.ts` } });
  expect(h.inputs.map((input) => input.prompt)).toEqual([
    "Triage file-0.ts",
    "Triage file-0.ts",
    "Triage file-1.ts",
  ]);
  for (const result of h.completions)
    result.resolve({ threadId: "retry", status: "succeeded", result: "Retried" });
  await h.service.settled();
  expect(h.service.inbox().runs.filter((run) => run.status === "succeeded")).toHaveLength(3);
  h.service.stop();
  expect(active.size).toBe(0);
});

it("stops startup recovery before subscribing to later durable runs", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.put(definition({ id: "other" }));
  const first = h.service.trigger("triage", { key: "first", variables: { subject: "first" } });
  const second = h.service.trigger("other", { key: "second", variables: { subject: "second" } });
  h.service.stop();
  const observed = new Set<string>();
  const active = new Map<string, ReturnType<typeof deferred<ExecutionResult | undefined>>>();
  let stop = true;
  h.deps.executor.recover = (key: string, signal?: AbortSignal) => {
    observed.add(key);
    const result = deferred<ExecutionResult | undefined>();
    active.set(key, result);
    signal?.addEventListener(
      "abort",
      () => {
        active.delete(key);
        result.resolve(undefined);
      },
      { once: true },
    );
    if (stop) {
      stop = false;
      h.service.stop();
    }
    return result.promise;
  };
  h.service.start();
  expect([...observed]).toEqual([first.id]);
  expect(active.size).toBe(0);
  expect(h.service.inbox().runs.map((run) => run.status)).toEqual(["running", "running"]);
  expect(() => h.service.trigger("triage", { key: "stopped", variables: {} })).toThrow("stopped");
  h.service.start();
  expect([...active.keys()]).toEqual([first.id, second.id]);
  for (const [key, result] of active) {
    active.delete(key);
    result.resolve({ threadId: `recovered-${key}`, status: "succeeded", result: "Recovered" });
  }
  await h.service.settled();
  expect(h.service.inbox().runs).toMatchObject([
    { id: second.id, threadId: `recovered-${second.id}`, status: "succeeded" },
    { id: first.id, threadId: `recovered-${first.id}`, status: "succeeded" },
  ]);
  h.service.stop();
  expect(active.size).toBe(0);
});

it("leaves later schedule cursors unchanged when a subscription stops startup", () => {
  const h = harness();
  h.service.stop();
  h.service.put(definition({ id: "a-watch", trigger: { kind: "file", paths: ["src/**"] } }));
  h.service.put({ ...scheduled("skip"), id: "z-schedule" });
  const before = h.store.get("z-schedule");
  expect(before).toMatchObject({ nominal: start, due: start });
  h.now = start + 3 * 86_400_000;
  let stop = true;
  h.deps.workspace = {
    subscribe() {
      if (stop) {
        stop = false;
        h.service.stop();
      }
      return () => {};
    },
  };
  h.service.start();
  expect(h.store.get("z-schedule")).toEqual(before);
  expect(h.timer.active.size).toBe(0);
  expect(h.service.inbox().runs).toEqual([]);
  h.service.start();
  expect(h.store.get("z-schedule")).toMatchObject({
    nominal: Date.parse("2024-01-05T09:00:00Z"),
    due: Date.parse("2024-01-05T09:00:00Z"),
  });
  expect(h.timer.delay).toBe(60_000);
});
