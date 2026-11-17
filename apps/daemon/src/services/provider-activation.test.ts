import { expect, test } from "vitest";
import { activateProviders, discoverThenBind, engineReadiness } from "./provider-activation.ts";

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("the engine stays starting, and sessions keep waiting, while a provider CLI never answers", async () => {
  const cli = Promise.withResolvers<void>();
  let bound = false;
  const activation = activateProviders({
    signal: new AbortController().signal,
    captureSkillRoots: async () => [],
    discover: () => cli.promise,
    bind: async () => {
      bound = true;
    },
  });
  const readiness = engineReadiness(activation, Promise.resolve());
  let sessionsMayOpen = false;
  void activation.settled.then(() => {
    sessionsMayOpen = true;
  });
  await settle();
  expect(readiness()).toEqual({ state: "starting" });
  expect(sessionsMayOpen).toBe(false);

  cli.resolve();
  await settle();
  expect(bound).toBe(true);
  expect(sessionsMayOpen).toBe(true);
  expect(readiness()).toEqual({ state: "ready" });
});

test("adapters registered before discovery failed are still bound, and the engine says discovery failed", async () => {
  const registered: string[] = [];
  const bound: string[] = [];
  const activation = activateProviders({
    signal: new AbortController().signal,
    captureSkillRoots: async () => [],
    discover: async () => {
      registered.push("codex");
      throw new Error("claude did not answer");
    },
    bind: async () => {
      bound.push(...registered);
    },
  });
  await activation.settled;
  expect(bound).toEqual(["codex"]);
  expect(engineReadiness(activation, Promise.resolve())()).toEqual({
    state: "degraded",
    error: "Provider discovery failed: claude did not answer",
  });
});

test("skill folders are recorded before any adapter is bound, so none a new session makes is taken", async () => {
  const order: string[] = [];
  const activation = activateProviders({
    signal: new AbortController().signal,
    captureSkillRoots: async () => {
      order.push("capture");
      return ["session-abc123"];
    },
    discover: async () => {
      order.push("discover");
    },
    bind: async () => {
      order.push("bind");
    },
  });
  await activation.settled;
  expect(order).toEqual(["capture", "discover", "bind"]);
  expect(await activation.skillRoots).toEqual(["session-abc123"]);
});

test("an unreadable skill folder is reported and providers still activate", async () => {
  const reported: unknown[] = [];
  const activation = activateProviders({
    signal: new AbortController().signal,
    captureSkillRoots: async () => {
      throw new Error("Invalid skill session directory");
    },
    discover: async () => {},
    bind: async () => {},
    report: (error) => reported.push(error),
  });
  await activation.settled;
  expect(await activation.skillRoots).toBeUndefined();
  expect(reported).toHaveLength(1);
  expect(activation.state()).toEqual({ state: "ready" });
});

test("failed thread recovery shows the engine degraded even after providers are read", async () => {
  const activation = activateProviders({
    signal: new AbortController().signal,
    captureSkillRoots: async () => [],
    discover: async () => {},
    bind: async () => {},
  });
  const recovered = Promise.reject(new Error("store busy"));
  recovered.catch(() => {});
  const readiness = engineReadiness(activation, recovered);
  await activation.settled;
  await settle();
  expect(readiness()).toEqual({ state: "degraded", error: "Thread recovery failed: store busy" });
});

test("a rediscovery that registers Pi and then fails still binds Pi before it reports the failure", async () => {
  const registered: string[] = [];
  const bound: string[] = [];
  const reading = discoverThenBind({
    signal: new AbortController().signal,
    discover: async () => {
      registered.push("pi");
      throw new Error("Antigravity launch could not be resolved");
    },
    bind: async () => {
      bound.push(...registered);
    },
  });
  await expect(reading).rejects.toThrow("Antigravity launch could not be resolved");
  expect(bound).toEqual(["pi"]);
});

test("a failed binding is reported when discovery itself succeeded", async () => {
  await expect(
    discoverThenBind({
      signal: new AbortController().signal,
      discover: async () => {},
      bind: async () => {
        throw new Error("Cursor sign-in unavailable");
      },
    }),
  ).rejects.toThrow("Cursor sign-in unavailable");
});
