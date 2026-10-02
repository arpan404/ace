import { expect, it } from "vitest";
import { definition, harness, scheduled } from "./service-test-support.ts";

it("releases file watchers when timer cancellation throws and error reporting reenters lifecycle", async () => {
  const h = harness();
  const arm = h.timer.arm.bind(h.timer);
  let fail = true;
  h.timer.arm = (delay, callback) => {
    const cancel = arm(delay, callback);
    return () => {
      cancel();
      if (fail) {
        fail = false;
        throw new Error("timer cancellation failed");
      }
    };
  };
  h.deps.onError = (error) => {
    h.errors.push(error);
    h.service.start();
    h.service.stop();
  };
  h.service.put(definition({ id: "watch", trigger: { kind: "file", paths: ["src/**"] } }));
  h.service.put(scheduled());
  expect(h.watches.size).toBe(1);
  expect(h.timer.active.size).toBe(1);
  expect(() => h.service.stop()).not.toThrow();
  expect(h.errors).toEqual([new Error("timer cancellation failed")]);
  expect(h.watches.size).toBe(0);
  expect(h.timer.active.size).toBe(0);
  expect(() => h.service.trigger("watch", { key: "stopped", variables: {} })).toThrow("stopped");
  h.service.start();
  expect(h.timer.active.size).toBe(1);
  const receive = h.watches.get("/project");
  if (!receive) throw new Error("Missing restarted watcher");
  await receive({ key: "restarted", variables: { subject: "src/main.ts" } });
  expect(h.inputs[0]?.prompt).toBe("Triage src/main.ts");
  await h.finish();
  h.service.stop();
  expect(h.watches.size).toBe(0);
  expect(h.timer.active.size).toBe(0);
});
