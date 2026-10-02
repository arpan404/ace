import { expect, it } from "vitest";
import { harness, definition, deferred } from "./service-test-support.ts";
import type { AutomationEvent } from "@ace/protocol";
import type { ExecutionResult } from "./index.ts";

it("stays stopped when executor cancellation attempts a synchronous restart", async () => {
  const h = harness();
  const active = new Set<symbol>();
  const results: ReturnType<typeof deferred<ExecutionResult>>[] = [];
  let restart = true;
  const watch = (signal?: AbortSignal) => {
    const token = Symbol();
    const result = deferred<ExecutionResult>();
    active.add(token);
    results.push(result);
    signal?.addEventListener(
      "abort",
      () => {
        active.delete(token);
        result.resolve({ threadId: "obsolete", status: "succeeded", result: "obsolete" });
        if (restart) {
          restart = false;
          h.service.start();
        }
      },
      { once: true },
    );
    return result.promise.finally(() => {
      active.delete(token);
    });
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
    h.service.trigger("triage", { key: "before-stop", variables: { subject: "issues" } });
    h.service.stop();
    expect(active.size).toBe(0);
    expect(() =>
      h.service.trigger("triage", { key: "during-stop", variables: { subject: "issues" } }),
    ).toThrow("stopped");
    h.service.start();
    expect(active.size).toBe(1);
    results.at(-1)?.resolve({ threadId: "recovered", status: "succeeded", result: "recovered" });
    await h.service.settled();
    expect(h.service.inbox().runs).toMatchObject([{ status: "succeeded", threadId: "recovered" }]);
    h.service.stop();
    expect(active.size).toBe(0);
  } finally {
    restart = false;
    h.service.stop();
    for (const result of results)
      result.resolve({ threadId: "cleanup", status: "succeeded", result: "cleanup" });
  }
});

it("retains watcher ownership after cleanup error reporting attempts a restart", async () => {
  const h = harness();
  const active = new Map<symbol, (event: AutomationEvent) => Promise<void>>();
  let fail = true;
  h.deps.workspace = {
    subscribe(_root, _paths, receive) {
      const token = Symbol();
      active.set(token, receive);
      return () => {
        active.delete(token);
        if (fail) {
          fail = false;
          throw new Error("cleanup failure");
        }
      };
    },
  };
  h.deps.onError = () => {
    h.service.start();
  };
  h.service.put(definition({ trigger: { kind: "file", paths: ["src/**"] } }));
  h.service.stop();
  expect(active.size).toBe(0);
  expect(() =>
    h.service.trigger("triage", { key: "during-stop", variables: { subject: "issues" } }),
  ).toThrow("stopped");
  h.service.start();
  expect(active.size).toBe(1);
  const receive = active.values().next().value;
  if (!receive) throw new Error("Missing active watcher");
  await receive({ key: "new-watcher", variables: { subject: "src/main.ts" } });
  expect(h.inputs[0]?.prompt).toBe("Triage src/main.ts");
  await h.finish();
  h.service.stop();
  expect(active.size).toBe(0);
});

it("finishes cleanup when a workspace subscription stops startup", () => {
  const h = harness();
  h.service.put(definition({ trigger: { kind: "file", paths: ["src/**"] } }));
  h.service.stop();
  const active = new Set<symbol>();
  let stop = true;
  h.deps.workspace = {
    subscribe() {
      const token = Symbol();
      active.add(token);
      if (stop) {
        stop = false;
        h.service.stop();
      }
      return () => {
        active.delete(token);
      };
    },
  };
  h.service.start();
  expect(active.size).toBe(0);
  expect(() =>
    h.service.trigger("triage", { key: "stopped-startup", variables: { subject: "issues" } }),
  ).toThrow("stopped");
  h.service.start();
  expect(active.size).toBe(1);
  h.service.stop();
  expect(active.size).toBe(0);
});
