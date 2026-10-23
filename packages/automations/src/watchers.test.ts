import { expect, it } from "vitest";
import { harness, definition } from "./service-test-support.ts";
import type { AutomationEvent } from "@ace/protocol";
it("persists a failed workspace subscription with health and heals on retry", async () => {
  const h = harness();
  let fail = true;
  h.deps.workspace = {
    subscribe(path, _paths, receive, hooks) {
      if (fail) throw new Error("watcher unavailable");
      h.watches.set(path, receive);
      hooks?.onReady?.();
      return () => {
        h.watches.delete(path);
      };
    },
  };
  const auto = definition({ trigger: { kind: "file", paths: ["src/**"] } });
  // One stale workspace no longer blocks the save: the definition persists
  // with durable health instead of leaving no definition behind.
  h.service.put(auto);
  expect(h.service.list()).toEqual([auto]);
  expect(
    h.service.handle({ type: "automation.list", requestId: "unhealthy" }).schedules,
  ).toMatchObject([{ id: "triage", triggerError: { message: "watcher unavailable" } }]);
  fail = false;
  h.service.put(auto);
  expect(
    h.service.handle({ type: "automation.list", requestId: "healed" }).schedules?.[0]?.triggerError,
  ).toBeUndefined();
  await h.watches.get("/project")?.({ key: "changed", variables: { subject: "src/main.ts" } });
  expect(h.inputs[0]?.prompt).toBe("Triage src/main.ts");
  await h.finish();
});
it("attempts every watcher cleanup and ignores retained callbacks after stop", async () => {
  const h = harness();
  const callbacks = new Map<string, (event: AutomationEvent) => Promise<void>>();
  const active = new Set<string>();
  h.deps.workspace = {
    subscribe(path, _paths, receive) {
      callbacks.set(path, receive);
      active.add(path);
      return () => {
        if (path === "/first") throw new Error("first cleanup failed");
        active.delete(path);
      };
    },
  };
  h.service.put(
    definition({ id: "first", workspace: "/first", trigger: { kind: "file", paths: ["src/**"] } }),
  );
  h.service.put(
    definition({
      id: "second",
      workspace: "/second",
      trigger: { kind: "file", paths: ["src/**"] },
    }),
  );
  expect(() => h.service.stop()).not.toThrow();
  expect(active.has("/second")).toBe(false);
  await callbacks.get("/first")?.({ key: "late", variables: { subject: "late change" } });
  expect(h.inputs).toEqual([]);
  expect(h.errors).toEqual([expect.objectContaining({ message: "first cleanup failed" })]);
});
it("preserves the old watcher and configuration when replacement subscription fails", async () => {
  const h = harness();
  const old = definition({ trigger: { kind: "file", paths: ["src/**"] } });
  h.service.put(old);
  h.deps.workspace = {
    subscribe() {
      throw new Error("replacement failed");
    },
  };
  expect(() => h.service.put({ ...old, prompt: "Changed {{subject}}" })).toThrow(
    "replacement failed",
  );
  expect(h.service.list()).toEqual([old]);
  await h.watches.get("/project")?.({ key: "old-watch", variables: { subject: "src/main.ts" } });
  expect(h.inputs[0]?.prompt).toBe("Triage src/main.ts");
  await h.finish();
});
