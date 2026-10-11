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

it("rolls back installed watchers after partial startup failure and permits a usable retry", async () => {
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
    subscribe(root, _paths, receive) {
      if (root === "/second" && fail) {
        fail = false;
        throw new Error("second subscription failed");
      }
      const token = Symbol();
      active.set(token, { root, receive });
      return () => {
        active.delete(token);
      };
    },
  };
  expect(() => h.service.start()).toThrow("second subscription failed");
  expect(active.size).toBe(0);
  expect(h.service.list()).toEqual([first, second]);
  expect(() => h.service.trigger("a-watch", { key: "failed-start", variables: {} })).toThrow(
    "stopped",
  );
  expect(h.service.inbox().runs).toEqual([]);
  h.service.start();
  expect([...active.values()].map((watch) => watch.root)).toEqual(["/first", "/second"]);
  for (const [index, watch] of [...active.values()].entries())
    await watch.receive({ key: `retry-${index}`, variables: { subject: `file-${index}.ts` } });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Triage file-0.ts", "Triage file-1.ts"]);
  for (const [index, result] of h.completions.entries())
    result.resolve({ threadId: `retry-${index}`, status: "succeeded", result: "Retried" });
  await h.service.settled();
  expect(h.service.inbox().runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
  h.service.stop();
  expect(active.size).toBe(0);
});

it("stops startup recovery before subscribing to later durable runs", async () => {
  const h = harness();
  h.service.put(definition({ concurrency: 2 }));
  const first = h.service.trigger("triage", { key: "first", variables: { subject: "first" } });
  const second = h.service.trigger("triage", { key: "second", variables: { subject: "second" } });
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
