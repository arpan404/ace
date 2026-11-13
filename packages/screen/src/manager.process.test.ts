import { setImmediate } from "node:timers/promises";
import { helperGate } from "./testing/gate.ts";
import { afterEach, expect, it } from "vitest";
import { computerUseHandler, type Frame } from "./index.ts";
import { deferred, manager, ready, target } from "./testing/support.ts";
import { ScreenCowork } from "./cowork.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup(env: NodeJS.ProcessEnv = {}) {
  const test = await manager(env);
  cleanups.push(test.close);
  return test.screen;
}
it("capture is off until computer use is turned on, then needs no per-app approval", async () => {
  const screen = await setup();
  await expect(screen.start(target)).rejects.toThrow("disabled");
  await screen.enable(true);
  const state = await screen.start(target);
  expect(state.indicator).toBe(true);
});
it("denied Screen Recording prevents capture and denied Accessibility prevents input", async () => {
  const denied = await setup({ SCREEN_DENIED: "1" });
  await expect(ready(denied)).rejects.toThrow("permission denied");
  const screen = await setup({ ACCESS_DENIED: "1" });
  const state = await ready(screen);
  screen.controller(state.sessionId, "agent");
  await expect(
    screen.action(state.sessionId, "agent", { kind: "type", text: "hello" }),
  ).rejects.toThrow("permission denied");
  expect(await screen.permissions()).toEqual({ screenRecording: true, accessibility: false });
});
it("live screenshots and MCP actions use the delegated session and human takeover removes agent access", async () => {
  const screen = await setup({ FAKE_V2: "1" });
  const state = await ready(screen);
  const id = state.sessionId;
  const received = deferred<Frame>();
  screen.subscribe(id, async (value) => {
    received.resolve(value);
  });
  const tool = computerUseHandler(screen, id, "agent-1");
  await expect(tool("screen_input", { action: "type", text: "hello" })).rejects.toThrow(
    "ownership",
  );
  screen.controller(id, "agent", "agent-1");
  await tool("screen_input", { action: "type", text: "hello" });
  const firstFrame = await received.promise;
  expect(firstFrame.payload.toString()).toBe("jpeg-0");
  const screenshot = await tool("screen_screenshot", {});
  expect(screenshot).toEqual({
    _meta: { "ace/screen": { mode: "background", scale: 1, size: { width: 100, height: 100 } } },
    content: [
      {
        type: "image",
        data: screen.screenshot(id).payload.toString("base64"),
        mimeType: "image/jpeg",
      },
      {
        type: "text",
        text: expect.stringContaining("scale 1 for screen_input points"),
      },
    ],
  });
  expect(screenshot.content[0]).not.toMatchObject({ data: firstFrame.payload.toString("base64") });
  screen.controller(id, "human", "human-1");
  await expect(tool("screen_input", { action: "click", x: 1, y: 2 })).rejects.toThrow("ownership");
  await expect(
    screen.action(id, "human", { kind: "type", text: "hello" }, "human-2"),
  ).rejects.toThrow("ownership");
  await screen.action(id, "human", { kind: "type", text: "hello" }, "human-1");
  screen.releaseController("human-1");
  expect(screen.state(id).controller).toBe("none");
  await screen.enable(false);
  expect(() => screen.screenshot(id)).toThrow("Unknown");
});
it("display streams cannot inject input even with a controller", async () => {
  const screen = await setup();
  await screen.enable(true);
  const state = await screen.start({ kind: "display", displayId: 1, bundleIds: [target.bundleId] });
  screen.controller(state.sessionId, "human");
  await expect(
    screen.action(state.sessionId, "human", { kind: "type", text: "hello" }),
  ).rejects.toThrow("view-only");
});
it("permission revocation is checked again before each action", async () => {
  const screen = await setup({ REVOKE_ACCESS: "1" });
  const state = await ready(screen);
  screen.controller(state.sessionId, "agent");
  await expect(
    screen.action(state.sessionId, "agent", { kind: "type", text: "hello" }),
  ).rejects.toThrow("permission denied");
});
it("a crashed helper clears cached frames and controller state and can be explicitly restarted", async () => {
  const screen = await setup({ FAKE_V2: "1" });
  const state = await ready(screen);
  const id = state.sessionId;
  screen.controller(id, "agent");
  const first = deferred<Frame>();
  screen.subscribe(id, async (value) => {
    first.resolve(value);
  });
  await screen.action(id, "agent", { kind: "type", text: "hello" });
  await first.promise;
  const failed = deferred<void>();
  screen.watch((value) => {
    if (value.lifecycle === "failed") failed.resolve();
  });
  await expect(screen.action(id, "agent", { kind: "type", text: "crash" })).rejects.toThrow();
  await failed.promise;
  expect(screen.states()).toEqual([]);
  expect(() => screen.screenshot(id)).toThrow("Unknown");
  const restarted = await screen.start(target);
  expect(restarted.controller).toBe("none");
  expect(restarted.sessionId).not.toBe(id);
});
it("human takeover cancels queued input before it can update permission state", async () => {
  const screen = await setup({ REVOKE_ACCESS: "1" });
  const state = await ready(screen);
  screen.controller(state.sessionId, "agent");
  const action = screen.action(state.sessionId, "agent", { kind: "type", text: "hello" });
  screen.controller(state.sessionId, "human");
  await expect(action).rejects.toThrow("Controller changed");
  expect(screen.state(state.sessionId).permissions.accessibility).toBe(true);
});
it("an app lease cannot be acquired twice and disabling stops its capture", async () => {
  const screen = await setup();
  const state = await ready(screen);
  screen.controller(state.sessionId, "agent", "owner");
  await expect(screen.start(target)).rejects.toThrow("target_busy");
  await screen.enable(false);
  await expect(screen.start(target)).rejects.toThrow("disabled");
});

it("frames delivered during startup remain available after the session becomes live", async () => {
  const screen = await setup({ INITIAL_FRAME: "1" });
  const state = await ready(screen);
  const first = deferred<Frame>();
  screen.subscribe(state.sessionId, async (value) => first.resolve(value));
  expect((await first.promise).payload.toString()).toBe("jpeg-0");
  expect(screen.screenshot(state.sessionId).payload.toString()).toBe("jpeg-0");
});
it("takeover during permission inspection prevents the pending input effect", async () => {
  const gate = await helperGate();
  cleanups.push(gate.close);
  const screen = await setup({ PERMISSION_GATE_PORT: gate.port });
  const state = await ready(screen);
  screen.controller(state.sessionId, "agent", "agent");
  const action = expect(
    screen.action(state.sessionId, "agent", { kind: "type", text: "denied" }, "agent"),
  ).rejects.toThrow("Controller changed");
  await gate.reached;
  screen.controller(state.sessionId, "human", "human");
  gate.release();
  await action;
  expect(screen.state(state.sessionId).controller).toBe("human");
  expect(() => screen.screenshot(state.sessionId)).toThrow("No captured frame");
});
it("in cowork the person's live-view input reaches an agent's session without its controls, and shows them active", async () => {
  let now = 1_000;
  const cowork = new ScreenCowork({ clock: { now: () => now, set: () => () => {} } });
  const test = await manager({ FAKE_V2: "1" }, { cowork });
  cleanups.push(test.close);
  const screen = test.screen;
  const state = await ready(screen);
  const id = state.sessionId;
  screen.controller(id, "agent", "agent-1");
  await screen.input(id, "human", { kind: "text.type", text: "hi" }, "human-1");
  expect(screen.state(id)).toMatchObject({
    controller: "agent",
    sharing: "cowork",
    personActive: true,
  });
  expect((await screen.uiFind(id, { query: { name: "Typed text" } })).nodes[0]?.value).toBe("hi");
  // A person's Take control is exclusive: another person's input stays out, as before.
  now += 10_000;
  screen.controller(id, "human", "human-1");
  expect(screen.state(id).sharing).toBe("exclusive");
  await expect(
    screen.input(id, "human", { kind: "text.type", text: "x" }, "human-2"),
  ).rejects.toThrow("ownership");
});

/** Hold A in the real helper while B clears its first presence check and queues behind it. */
async function queuedCowork() {
  let now = 1_000;
  const timers = new Set<{ at: number; run: () => void }>();
  const cowork = new ScreenCowork({
    clock: {
      now: () => now,
      set(ms, run) {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  const gate = await helperGate();
  cleanups.push(gate.close);
  const test = await manager({ FAKE_V2: "1", ACTION_GATE_PORT: gate.port }, { cowork });
  cleanups.push(test.close);
  const screen = test.screen;
  const { sessionId: id } = await ready(screen);
  screen.controller(id, "agent", "agent");
  const input = (actor: "human" | "agent", text: string) =>
    screen.input(id, actor, { kind: "text.type", text }, actor);
  const first = input("agent", "A");
  await gate.reached;
  const second = input("agent", "B");
  // Drain the initial presence check without releasing the helper's running action.
  await setImmediate();
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.at > now) continue;
      timers.delete(timer);
      timer.run();
    }
    await setImmediate();
  };
  const typed = async () =>
    (await screen.uiFind(id, { query: { name: "Typed text" } })).nodes[0]?.value;
  const personArrives = async () => {
    const person = input("human", "person");
    gate.release();
    await first;
    await person;
  };
  return { screen, id, second, advance, typed, personArrives };
}

it("a queued agent yields its slot when the person returns, then delivers input with a wait note", async () => {
  const test = await queuedCowork();
  await test.personArrives();
  expect(await test.typed()).toBe("Aperson");
  await test.advance(2_999);
  expect(await test.typed()).toBe("Aperson");
  await test.advance(1);
  expect(await test.second).toMatchObject({
    waited: "Waited 3 s while the person used dev.ace.test.",
  });
  expect(await test.typed()).toBe("ApersonB");
});

it("a dequeue retry keeps the original minute deadline and never sends the expired input", async () => {
  const test = await queuedCowork();
  const refused = expect(test.second).rejects.toMatchObject({ code: "person_busy" });
  await test.advance(59_000);
  await test.personArrives();
  await test.advance(1_000);
  await refused;
  expect(await test.typed()).toBe("Aperson");
});

it("takeover and re-delegation while an agent waits cannot revive its queued input", async () => {
  const test = await queuedCowork();
  const refused = expect(test.second).rejects.toThrow("Controller changed");
  await test.personArrives();
  test.screen.controller(test.id, "human", "human");
  test.screen.controller(test.id, "agent", "agent");
  await test.advance(3_000);
  await refused;
  expect(await test.typed()).toBe("Aperson");
});
