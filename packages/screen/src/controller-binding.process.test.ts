import { afterEach, expect, it } from "vitest";
import { ScreenAgentScope } from "@ace/protocol";
import { manager, ready } from "./testing/support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function setup(env: NodeJS.ProcessEnv = {}) {
  const host = await manager({ FAKE_V2: "1", ...env });
  cleanups.push(host.close);
  const state = await ready(host.screen);
  return { screen: host.screen, id: state.sessionId };
}
const scope = ScreenAgentScope.parse({ threadId: "device-thread", agentId: "device-agent" });
const owner = JSON.stringify([scope.threadId, scope.agentId]);

it("screen tools cannot use an externally bound agent after its lease expires", async () => {
  const { screen, id } = await setup();
  let now = 0;
  let expiresAt = 10;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (now >= expiresAt) throw new Error("Device lease expired");
    },
    released() {
      expiresAt = now;
    },
  });
  expect(screen.agentSession(scope)).toBe(id);
  await screen.input(id, "agent", { kind: "text.type", text: "allowed" }, owner);
  now = 20;
  expect(() => screen.agentSession(scope)).toThrow("Device lease expired");
  await expect(
    screen.input(id, "agent", { kind: "text.type", text: "denied" }, owner),
  ).rejects.toThrow("Device lease expired");
  await expect(
    screen.action(id, "agent", { kind: "click", x: 1, y: 2, button: "left" }, owner),
  ).rejects.toThrow("Device lease expired");
  expect((await screen.targets()).windows[0]?.title).toContain(";actions:1;");
});

it("an already expired controller is rejected before permission inspection changes visible state", async () => {
  const { screen, id } = await setup({ REVOKE_ACCESS: "1" });
  let expired = false;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (expired) throw new Error("Device lease expired");
    },
    released() {
      expired = true;
    },
  });
  expired = true;
  await expect(
    screen.input(id, "agent", { kind: "text.type", text: "denied" }, owner),
  ).rejects.toThrow("Device lease expired");
  expect(screen.state(id).permissions.accessibility).toBe(true);
});

it("expiry during permission inspection prevents the native input effect", async () => {
  const { screen, id } = await setup();
  let leaseActive = true;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (!leaseActive) throw new Error("Device lease expired");
    },
    released() {
      leaseActive = false;
    },
  });
  const unwatch = screen.watch((state) => {
    if (state.sessionId === id && state.controller === "agent") leaseActive = false;
  });
  try {
    await expect(
      screen.input(id, "agent", { kind: "text.type", text: "denied" }, owner),
    ).rejects.toThrow("Device lease expired");
    expect((await screen.targets()).windows[0]?.title).toContain(";actions:0;");
  } finally {
    unwatch();
  }
});

it("a human screen takeover releases external authority and receives ordinary input control", async () => {
  const { screen, id } = await setup();
  let leaseActive = true;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (!leaseActive) throw new Error("Device lease released");
    },
    released() {
      leaseActive = false;
    },
  });
  screen.controller(id, "human", "human");
  expect(leaseActive).toBe(false);
  expect(screen.state(id).controller).toBe("human");
  expect(() => screen.agentSession(scope)).toThrow("delegation");
  await screen.input(id, "human", { kind: "text.type", text: "human" }, "human");
  expect((await screen.targets()).windows[0]?.title).toContain(";actions:1;");
});

it("stopping capture releases its external controller even when no other controller takes over", async () => {
  const { screen, id } = await setup();
  let leaseActive = true;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (!leaseActive) throw new Error("Device lease released");
    },
    released() {
      leaseActive = false;
    },
  });
  await screen.stop(id);
  expect(leaseActive).toBe(false);
  expect(screen.states()).toEqual([]);
});

it("a crashing helper releases the bound device lease before another session can use it", async () => {
  const { screen, id } = await setup();
  let leaseActive = true;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (!leaseActive) throw new Error("Device lease released");
    },
    released() {
      leaseActive = false;
    },
  });
  await expect(
    screen.action(id, "agent", { kind: "type", text: "crash" }, owner),
  ).rejects.toThrow();
  expect(leaseActive).toBe(false);
  expect(() => screen.agentSession(scope)).toThrow();
});

it("a failed external release leaves previous and requested input controllers unauthorized", async () => {
  const { screen, id } = await setup();
  let failed = false;
  screen.controller(id, "agent", owner, {
    authorize() {
      if (failed) throw new Error("Device lease invalid");
    },
    released() {
      failed = true;
      throw new Error("External release failed");
    },
  });
  expect(() => screen.controller(id, "human", "human")).toThrow("External release failed");
  expect(screen.state(id).controller).toBe("none");
  await expect(
    screen.input(id, "agent", { kind: "text.type", text: "old" }, owner),
  ).rejects.toThrow("ownership");
  await expect(
    screen.input(id, "human", { kind: "text.type", text: "new" }, "human"),
  ).rejects.toThrow("ownership");
  expect((await screen.targets()).windows[0]?.title).toContain(";actions:0;");
});
