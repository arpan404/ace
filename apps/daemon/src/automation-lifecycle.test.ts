import { expect, test } from "vitest";
import type { AutomationService } from "@ace/automations";
import { followAutomationSetting } from "./automation-lifecycle.ts";
import type { ServiceContext } from "./services/types.ts";

const settle = async () => {
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function fixture(initial: boolean) {
  let enabled = initial;
  let clock = 0;
  const listeners = new Set<(notification: unknown) => void>();
  const settings = {
    async get() {
      return { value: enabled };
    },
    async subscribe(_spec: unknown, listener: (notification: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(value: boolean) {
      enabled = value;
      for (const listener of listeners)
        listener({ type: "changed", entries: [{ key: "automations.enabled", value }] });
    },
  };
  const service = {
    starts: 0,
    stops: 0,
    start() {
      this.starts++;
    },
    stop() {
      this.stops++;
    },
  };
  const shutdown: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  let ids = 0;
  const context = {
    services: { settings, modelsReady: new Promise<void>(() => {}) },
    options: { automationModelWaitMs: 30_000 },
    now: () => clock,
    log: { log() {} },
    resources: {
      onShutdown(listener: () => void) {
        shutdown.push(listener);
      },
      own() {},
    },
    signal: new AbortController().signal,
  } as unknown as ServiceContext;
  return {
    context,
    service,
    settings,
    shutdown,
    timers,
    advance(to: number) {
      clock = to;
    },
    async enable() {
      await followAutomationSetting(
        context,
        service as unknown as AutomationService,
        (callback) => {
          const id = ++ids;
          timers.set(id, callback);
          return () => {
            timers.delete(id);
          };
        },
      );
    },
    fire() {
      const armed = [...timers.values()];
      timers.clear();
      for (const callback of armed) callback();
    },
  };
}

test("a readiness wait that never settles arms the scheduler at its deadline", async () => {
  const f = fixture(true);
  await f.enable();
  expect(f.timers.size).toBe(1);
  expect(f.service.starts).toBe(0);
  f.advance(30_000);
  f.fire();
  await settle();
  expect(f.service.starts).toBe(1);
});

test("disabling cancels the pending readiness deadline", async () => {
  const f = fixture(true);
  await f.enable();
  expect(f.timers.size).toBe(1);
  f.settings.set(false);
  await settle();
  expect(f.timers.size).toBe(0);
  expect(f.service.stops).toBe(1);
  expect(f.service.starts).toBe(0);
});

test("shutdown cancels the pending readiness deadline", async () => {
  const f = fixture(true);
  await f.enable();
  expect(f.timers.size).toBe(1);
  for (const listener of f.shutdown) listener();
  await settle();
  expect(f.timers.size).toBe(0);
  expect(f.service.stops).toBe(1);
  expect(f.service.starts).toBe(0);
});
