import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Helper,
  ScreenManager,
  computerUseHandler,
  linuxBackend,
  installedLinuxHelper,
  type Frame,
} from "./index.ts";
import { ids, target, deferred } from "./testing/support.ts";
const command = {
  command: process.execPath,
  args: [new URL("./testing/fake-helper-v2.ts", import.meta.url).pathname],
  protocolVersion: 2 as const,
};
it("Linux prefers the portal over XWayland and refuses a missing selected display", () => {
  expect(linuxBackend({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
  expect(linuxBackend({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, "x11")).toBe("x11");
  expect(() => linuxBackend({ DISPLAY: ":0" }, "wayland")).toThrow("No display");
  expect(() => linuxBackend({})).toThrow("headless");
  expect(installedLinuxHelper("/ace", "arm64")).toBe(
    "/ace/helpers/screen-linux/arm64/ace-screen-helper-linux",
  );
  expect(() => installedLinuxHelper("/ace", "ia32")).toThrow("x86_64");
});
it("v2 negotiates its display backend and delivers frames with scale and aliases", async () => {
  const frame = deferred<Frame>();
  const helper = await Helper.open({
    ...command,
    expectedPlatform: "linux-x11",
    nextId: ids(),
    onFrame: (f) => frame.resolve(f),
    onFailure: () => {},
  });
  try {
    expect(helper.capabilities?.capture.changeDriven).toBe(true);
    await helper.request({
      op: "start",
      sessionId: "v2",
      target,
      allowlist: [target.bundleId],
      fps: 10,
    });
    await helper.request({ op: "key.press", key: "Enter", modifiers: [] });
    expect((await frame.promise).header).toMatchObject({ version: 2, scale: 1, seq: 0, ts: 1000 });
    await expect(helper.request({ op: "ui.act", ref: "gone", action: "press" })).rejects.toThrow(
      "Unknown ref",
    );
  } finally {
    await helper.close();
  }
  await expect(
    Helper.open({
      ...command,
      expectedPlatform: "linux-wayland",
      nextId: ids(),
      onFrame: () => {},
      onFailure: () => {},
    }),
  ).rejects.toThrow("backend differs");
});
it("one helper survives inspections and sequential captures while semantic tools enforce ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-v2-test-"));
  const manager = new ScreenManager({
    ...command,
    nextId: ids(),
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  try {
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const first = await manager.capabilities();
    await manager.permissions();
    await manager.targets();
    let state = await manager.start(target);
    const handler = computerUseHandler(manager, state.sessionId, "agent-a");
    expect((await handler("screen_ui_tree", {})).content).toMatchObject([
      { type: "text", text: expect.stringContaining("stable-entry") },
    ]);
    await expect(
      handler("screen_ui_act", { ref: "stable-entry", action: "setValue", value: "hello" }),
    ).rejects.toThrow("ownership");
    manager.controller(state.sessionId, "agent", "agent-a");
    expect(
      (await handler("screen_ui_act", { ref: "stable-entry", action: "setValue", value: "héllo" }))
        .content,
    ).toMatchObject([{ text: expect.stringContaining('"fallback":false') }]);
    expect((await handler("screen_ui_find", { query: { name: "Message" } })).content).toMatchObject(
      [{ text: expect.stringContaining("héllo") }],
    );
    manager.controller(state.sessionId, "human", "human");
    await expect(
      handler("screen_ui_act", { ref: "stable-entry", action: "press" }),
    ).rejects.toThrow("ownership");
    await manager.stop(state.sessionId);
    state = await manager.start(target);
    expect(await manager.capabilities()).toEqual(first);
    await manager.stop(state.sessionId);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("negotiated UI support and capture scope reject unsupported operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-v2-denied-"));
  const manager = new ScreenManager({
    ...command,
    env: { NO_UI: "1" },
    nextId: ids(),
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  try {
    await manager.enable(true);
    await manager.approve(target.bundleId, true);
    const state = await manager.start(target);
    await expect(
      computerUseHandler(manager, state.sessionId, "agent")("screen_ui_tree", {}),
    ).rejects.toThrow("no UI tree");
    await manager.stop(state.sessionId);
    await expect(
      manager.start({ kind: "display", displayId: 1, bundleIds: [target.bundleId] }),
    ).rejects.toThrow("capture target");
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
