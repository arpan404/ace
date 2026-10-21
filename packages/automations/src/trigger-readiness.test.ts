import { expect, test } from "vitest";
import type { AutomationEvent } from "@ace/protocol";
import { definition, harness } from "./service-test-support.ts";

test("editing a failed file trigger retains its error until the replacement watcher is ready", async () => {
  const h = harness();
  const readiness: (() => void)[] = [];
  const failures: ((error: unknown) => void)[] = [];
  const receivers: ((event: AutomationEvent) => Promise<void>)[] = [];
  h.deps.workspace = {
    subscribe(_root, _paths, receive, hooks) {
      if (hooks?.onReady) readiness.push(hooks.onReady);
      if (hooks?.onError) failures.push(hooks.onError);
      receivers.push(receive);
      return () => {};
    },
  };
  const automation = definition({ trigger: { kind: "file", paths: ["src/**"] } });
  h.service.put(automation);
  const fail = failures[0];
  if (!fail) throw new Error("Missing watcher failure boundary");
  fail(new Error("Project folder unavailable"));
  const health = () =>
    h.service.handle({ type: "automation.list", requestId: "health" }).schedules?.[0]?.triggerError;
  expect(health()?.message).toBe("Project folder unavailable");
  const staleReady = readiness[0];
  if (!staleReady) throw new Error("Missing old watcher readiness boundary");
  staleReady();
  expect(health()?.message).toBe("Project folder unavailable");
  h.service.put({ ...automation, prompt: "Review the changed file {{subject}}" });
  // Returning an unsubscribe function is not evidence the async watcher opened.
  expect(health()?.message).toBe("Project folder unavailable");
  const ready = readiness[1];
  if (!ready) throw new Error("Missing replacement watcher readiness boundary");
  staleReady();
  expect(health()?.message).toBe("Project folder unavailable");
  ready();
  expect(health()).toBeUndefined();
  const receive = receivers[1];
  if (!receive) throw new Error("Missing replacement watcher receiver");
  await receive({ key: "replacement-change", variables: { subject: "src/index.ts" } });
  expect(h.inputs.map((input) => input.prompt)).toEqual(["Review the changed file src/index.ts"]);
  await h.finish();
});
