import { helperGate } from "./testing/gate.ts";
import { afterEach, expect, it } from "vitest";
import { computerUseHandler, type Frame } from "./index.ts";
import { deferred, manager, ready, target } from "./testing/support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup(env: NodeJS.ProcessEnv = {}) {
  const test = await manager(env);
  cleanups.push(test.close);
  return test.screen;
}
it("capture is off by default and requires approval for every selected application", async () => {
  const screen = await setup();
  await expect(screen.start(target)).rejects.toThrow("disabled");
  await screen.enable(true);
  await expect(screen.start(target)).rejects.toThrow("approval");
  await screen.approve(target.bundleId, true);
  await expect(
    screen.start({
      kind: "display",
      displayId: 1,
      bundleIds: [target.bundleId, "com.apple.systempreferences"],
    }),
  ).rejects.toThrow("approval");
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
it("live screenshots and MCP actions use the approved session and human takeover removes agent access", async () => {
  const screen = await setup({ FAKE_V2: "1" });
  const state = await ready(screen);
  const id = state.sessionId;
  const received = deferred<Frame>();
  screen.subscribe(id, async (value) => {
    received.resolve(value);
  });
  const tool = computerUseHandler(screen, id, "agent-1");
  await expect(tool("screen_type", { text: "hello" })).rejects.toThrow("ownership");
  screen.controller(id, "agent", "agent-1");
  await tool("screen_type", { text: "hello" });
  const firstFrame = await received.promise;
  expect(firstFrame.payload.toString()).toBe("jpeg-0");
  const screenshot = await tool("screen_screenshot", {});
  expect(screenshot).toEqual({
    content: [
      {
        type: "image",
        data: screen.screenshot(id).payload.toString("base64"),
        mimeType: "image/jpeg",
      },
      {
        type: "text",
        text: expect.stringContaining("Screenshot scale: 1 pixels per target point"),
      },
    ],
  });
  expect(screenshot.content[0]).not.toMatchObject({ data: firstFrame.payload.toString("base64") });
  screen.controller(id, "human", "human-1");
  await expect(tool("screen_click", { x: 1, y: 2 })).rejects.toThrow("ownership");
  await expect(
    screen.action(id, "human", { kind: "type", text: "hello" }, "human-2"),
  ).rejects.toThrow("ownership");
  await screen.action(id, "human", { kind: "type", text: "hello" }, "human-1");
  screen.releaseController("human-1");
  expect(screen.state(id).controller).toBe("none");
  await screen.approve(target.bundleId, false);
  expect(() => screen.screenshot(id)).toThrow("Unknown");
});
it("display streams cannot inject input even with an approved controller", async () => {
  const screen = await setup();
  await screen.enable(true);
  await screen.approve(target.bundleId, true);
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
  expect(screen.state(id)).toMatchObject({
    lifecycle: "failed",
    indicator: false,
    controller: "none",
  });
  expect(() => screen.screenshot(id)).toThrow("not live");
  await screen.stop(id);
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
  await ready(screen);
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
