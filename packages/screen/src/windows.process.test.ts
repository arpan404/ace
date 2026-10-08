import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  Helper,
  ScreenManager,
  screenHelperPath,
  windowsEndpoint,
  computerUseHandler,
  type Frame,
} from "./index.ts";
import { spawnWindowsHelper } from "./windows-process.ts";
import { allowForeground } from "./testing/foreground.ts";
import { deferred, ids, target } from "./testing/support.ts";
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-v2-"));
  const options = {
    command: process.execPath,
    args: [new URL("./testing/fake-helper-v2.ts", import.meta.url).pathname],
    nextId: ids(),
    platform: "win32" as const,
    endpoint: `unix:${join(directory, "pipe")}`,
    env,
  };
  return { options, directory, clean: () => rm(directory, { recursive: true, force: true }) };
}
it("Windows resolves its installed executable and validates local pipe identifiers", () => {
  expect(screenHelperPath("C:\\ace-data", "win32")).toBe(
    "C:\\ace-data\\helpers\\screen\\ace-screen-helper-windows.exe",
  );
  expect(windowsEndpoint("abc-123")).toBe("pipe:\\\\.\\pipe\\ace-screen-abc-123");
  expect(() => windowsEndpoint("../bad")).toThrow();
  expect(() => screenHelperPath("/data", "freebsd")).toThrow();
});
it("v2 negotiates capabilities and receives fragmented frames from a helper-owned endpoint", async () => {
  const f = await fixture();
  const frame = deferred<Frame>();
  const failures: Error[] = [];
  const helper = await Helper.open({
    ...f.options,
    onFrame: frame.resolve,
    onFailure: (error) => failures.push(error),
  });
  try {
    expect(helper.capabilities?.platform).toBe("windows");
    expect(await helper.request({ op: "permissions" })).toEqual({
      screenRecording: true,
      accessibility: true,
    });
    await helper.request({
      op: "start",
      sessionId: "s",
      target,
      allowlist: [target.bundleId],
      fps: 10,
    });
    const received = await frame.promise;
    expect(received.header.sequence).toBe(0);
    expect(received.header.timestamp).toBe(1000);
    expect(received.header.scale).toBe(1.5);
    expect(received.payload.toString()).toBe("v2-jpeg-0");
    const length = received.packet.readUInt32BE();
    expect(JSON.parse(received.packet.subarray(4, 4 + length).toString())).toMatchObject({
      version: 2,
      scale: 1.5,
    });
    expect(failures).toEqual([]);
    await expect(
      helper.requestV2({ op: "ui.act", ref: "busy", action: "press" }),
    ).rejects.toMatchObject({ code: "busy", message: "UAC active" });
    expect(await helper.request({ op: "targets" })).toMatchObject({ windows: [{ windowId: 1 }] });
  } finally {
    await helper.close();
    await f.clean();
  }
});
it("an incompatible capability version closes the helper before capture", async () => {
  const f = await fixture({ BAD_VERSION: "1" });
  try {
    await expect(
      Helper.open({ ...f.options, onFrame: () => {}, onFailure: () => {} }),
    ).rejects.toThrow();
  } finally {
    await f.clean();
  }
});
it("one host helper serves inspections, restarts and semantic tools with controller checks", async () => {
  const f = await fixture({ PAYLOAD_VALUE: "1" });
  let spawned = 0;
  const manager = new ScreenManager({
    ...f.options,
    spawn: (options) => {
      spawned++;
      return spawnWindowsHelper(options);
    },
    recordingDirectory: f.directory,
    publishArtifact: async () => {},
  });
  try {
    expect(await manager.permissions()).toEqual({ screenRecording: true, accessibility: true });
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const before = await manager.targets();
    const session = await manager.start(target);
    manager.controller(session.sessionId, "agent", "agent-a");
    await allowForeground(manager, session.sessionId);
    const tool = computerUseHandler(manager, session.sessionId, "agent-a");
    const tree = await tool("screen_ui_tree", {});
    expect(tree.content).toEqual([
      { type: "text", text: expect.stringContaining('"name":"Save"') },
    ]);
    await tool("screen_ui_act", { ref: "save", action: "setValue", value: "你好 😀" });
    expect((await tool("screen_ui_find", { query: { name: "Save" } })).content).toEqual([
      { type: "text", text: expect.stringContaining("你好 😀") },
    ]);
    await manager.targets();
    const image = await tool("screen_screenshot", {});
    expect(image.content).toEqual([
      {
        type: "image",
        data: Buffer.from("pixels:你好 😀").toString("base64"),
        mimeType: "image/jpeg",
      },
      { type: "text", text: expect.stringContaining("1.5 pixels per target point") },
    ]);
    await tool("screen_key", { key: "Enter", modifiers: ["control"] });
    expect(await manager.uiTree(session.sessionId, {}, "agent-a")).toMatchObject({
      root: { value: "control:Enter" },
    });
    await expect(
      manager.uiAct(session.sessionId, "agent", { ref: "save", action: "press" }, "agent-b"),
    ).rejects.toThrow("ownership");
    manager.controller(session.sessionId, "human", "human-a");
    await expect(tool("screen_ui_act", { ref: "save", action: "press" })).rejects.toThrow(
      "ownership",
    );
    await manager.stop(session.sessionId);
    const after = await manager.targets();
    expect(after.windows[0]?.title.split(":")[0]).toBe(before.windows[0]?.title.split(":")[0]);
    await manager.start(target);
    expect(spawned).toBe(1);
  } finally {
    await manager.close();
    await f.clean();
  }
});
it("capture suspends without viewers and a fresh screenshot resumes it", async () => {
  const f = await fixture();
  const manager = new ScreenManager({
    ...f.options,
    recordingDirectory: f.directory,
    publishArtifact: async () => {},
  });
  try {
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const session = await manager.start(target);
    const received = deferred<Frame>();
    const unsubscribe = manager.subscribe(session.sessionId, async (frame) =>
      received.resolve(frame),
    );
    await received.promise;
    unsubscribe();
    expect((await manager.targets()).windows[0]?.title).toMatch(/:false$/);
    const fresh = await manager.screenshotFresh(session.sessionId);
    expect(fresh.payload.toString()).toMatch(/^v2-jpeg-/);
    expect((await manager.targets()).windows[0]?.title).toMatch(/:false$/);
  } finally {
    await manager.close();
    await f.clean();
  }
});
it("a crashed Windows helper clears screenshots and cannot retain agent ownership", async () => {
  const f = await fixture();
  const manager = new ScreenManager({
    ...f.options,
    recordingDirectory: f.directory,
    publishArtifact: async () => {},
  });
  try {
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const session = await manager.start(target);
    manager.controller(session.sessionId, "agent", "a");
    await allowForeground(manager, session.sessionId);
    await manager.screenshotFresh(session.sessionId);
    await expect(
      manager.action(session.sessionId, "agent", { kind: "type", text: "crash" }, "a"),
    ).rejects.toThrow();
    expect(manager.state(session.sessionId)).toMatchObject({
      lifecycle: "failed",
      controller: "none",
      indicator: false,
    });
    expect(() => manager.screenshot(session.sessionId)).toThrow();
    await manager.stop(session.sessionId);
    const replacement = await manager.start(target);
    expect(replacement.controller).toBe("none");
  } finally {
    await manager.close();
    await f.clean();
  }
});
it("a UI read cannot return after controller ownership changes", async () => {
  const f = await fixture();
  const manager = new ScreenManager({
    ...f.options,
    recordingDirectory: f.directory,
    publishArtifact: async () => {},
  });
  try {
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const session = await manager.start(target);
    manager.controller(session.sessionId, "agent", "a");
    const reading = manager.uiTree(session.sessionId, {}, "a");
    manager.controller(session.sessionId, "human", "b");
    await expect(reading).rejects.toThrow("ownership");
  } finally {
    await manager.close();
    await f.clean();
  }
});
it("an oversized UTF-8 command is rejected without killing the helper", async () => {
  const f = await fixture();
  const helper = await Helper.open({ ...f.options, onFrame: () => {}, onFailure: () => {} });
  try {
    await expect(
      helper.request({
        op: "start",
        sessionId: "s",
        target,
        fps: 10,
        allowlist: Array.from({ length: 64 }, () => "字".repeat(400)),
      }),
    ).rejects.toMatchObject({ code: "bounds" });
    expect(await helper.request({ op: "permissions" })).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  } finally {
    await helper.close();
    await f.clean();
  }
});
