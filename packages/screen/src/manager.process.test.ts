import { helperGate } from "./testing/gate.ts";
import { afterEach, expect, it } from "vitest";
import { spawnOwnedHelper } from "./helper.ts";
import { computerUseHandler, ScreenManager, type Frame } from "./index.ts";
import { deferred, manager, ready, target, v2Fixture, v2Helper } from "./testing/support.ts";
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
it("one host helper serves inspections, restarts and semantic tools with controller checks", async () => {
  const f = await v2Helper("win32", { PAYLOAD_VALUE: "1" });
  let spawned = 0;
  const screen = new ScreenManager({
    ...f.options,
    spawn: (options) => {
      spawned++;
      return spawnOwnedHelper(options);
    },
    recordingDirectory: f.directory,
    publishArtifact: async () => {},
  });
  try {
    expect(await screen.permissions()).toEqual({ screenRecording: true, accessibility: true });
    await screen.enable(true);
    const before = await screen.targets();
    const session = await screen.start(target);
    screen.controller(session.sessionId, "agent", "agent-a");
    screen.mode(session.sessionId, "foreground");
    const tool = computerUseHandler(screen, session.sessionId, "agent-a");
    const tree = await tool("screen_ui_tree", {});
    expect(tree.content).toEqual([
      { type: "text", text: expect.stringContaining('"name":"Save"') },
    ]);
    await tool("screen_ui_act", { ref: "save", action: "setValue", value: "你好 😀" });
    expect((await tool("screen_ui_tree", { name: "Save" })).content).toEqual([
      { type: "text", text: expect.stringContaining("你好 😀") },
    ]);
    await screen.targets();
    const image = await tool("screen_screenshot", {});
    expect(image.content).toEqual([
      {
        type: "image",
        data: Buffer.from("pixels:你好 😀").toString("base64"),
        mimeType: "image/jpeg",
      },
      { type: "text", text: expect.stringContaining("scale 1.5") },
    ]);
    await tool("screen_input", { action: "key", key: "Enter", modifiers: ["control"] });
    expect(await screen.uiTree(session.sessionId, {}, "agent-a")).toMatchObject({
      root: { value: "control:Enter" },
    });
    await expect(
      screen.uiAct(session.sessionId, "agent", { ref: "save", action: "press" }, "agent-b"),
    ).rejects.toThrow("ownership");
    screen.controller(session.sessionId, "human", "human-a");
    await expect(tool("screen_ui_act", { ref: "save", action: "press" })).rejects.toThrow(
      "ownership",
    );
    await screen.stop(session.sessionId);
    const after = await screen.targets();
    expect(after.windows[0]?.title.split(":")[0]).toBe(before.windows[0]?.title.split(":")[0]);
    await screen.start(target);
    expect(spawned).toBe(1);
  } finally {
    await screen.close();
    await f.clean();
  }
});
it("capture suspends without viewers and a fresh screenshot resumes it", async () => {
  const { manager: screen, close } = await v2Fixture("win32");
  try {
    const session = await screen.start(target);
    const received = deferred<Frame>();
    const unsubscribe = screen.subscribe(session.sessionId, async (frame) =>
      received.resolve(frame),
    );
    await received.promise;
    unsubscribe();
    expect((await screen.targets()).windows[0]?.title).toMatch(/:false$/);
    const fresh = await screen.captureScreenshot(session.sessionId);
    expect(fresh.payload.toString()).toMatch(/^v2-jpeg-/);
    expect((await screen.targets()).windows[0]?.title).toMatch(/:false$/);
  } finally {
    await close();
  }
});
it("a crashed Windows helper clears screenshots and cannot retain agent ownership", async () => {
  const { manager: screen, close } = await v2Fixture("win32");
  try {
    const session = await screen.start(target);
    screen.controller(session.sessionId, "agent", "a");
    screen.mode(session.sessionId, "foreground");
    await screen.captureScreenshot(session.sessionId);
    await expect(
      screen.action(session.sessionId, "agent", { kind: "type", text: "crash" }, "a"),
    ).rejects.toThrow();
    expect(screen.states()).toEqual([]);
    expect(() => screen.screenshot(session.sessionId)).toThrow();
    const replacement = await screen.start(target);
    expect(replacement.controller).toBe("none");
  } finally {
    await close();
  }
});
it("a UI read cannot return after controller ownership changes", async () => {
  const { manager: screen, close } = await v2Fixture("win32");
  try {
    const session = await screen.start(target);
    screen.controller(session.sessionId, "agent", "a");
    const reading = screen.uiTree(session.sessionId, {}, "a");
    screen.controller(session.sessionId, "human", "b");
    await expect(reading).rejects.toThrow("ownership");
  } finally {
    await close();
  }
});
