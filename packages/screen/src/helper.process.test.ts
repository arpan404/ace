import { access } from "node:fs/promises";
import { spawnSupervised } from "@ace/provider-kit/process";
import { expect, it } from "vitest";
import { Helper, screenHelperPath, windowsEndpoint, type Frame } from "./index.ts";
import { deferred, fakeCommand, ids, target, v2Helper } from "./testing/support.ts";
it("the supervised helper correlates concurrent commands and receives fragmented binary frames", async () => {
  const received = deferred<Frame>();
  const errors: Error[] = [];
  const helper = await Helper.open({
    ...fakeCommand,
    env: { REVERSE_REPLIES: "1" },
    scheduler: { schedule: () => () => {} },
    nextId: ids(),
    onFrame: (value) => received.resolve(value),
    onFailure: (error) => errors.push(error),
  });
  try {
    const [permissions, targets] = await Promise.all([
      helper.request({ op: "permissions" }),
      helper.request({ op: "targets" }),
    ]);
    expect(permissions).toEqual({ screenRecording: true, accessibility: true });
    expect(targets).toMatchObject({ windows: [{ title: "Test" }] });
    await helper.request({
      op: "start",
      sessionId: "test",
      target,
      allowlist: [target.bundleId],
      fps: 10,
    });
    expect(await helper.request({ op: "action", action: { kind: "type", text: "hello" } })).toEqual(
      { action: { kind: "type", text: "hello" } },
    );
    expect((await received.promise).payload.toString()).toBe("jpeg-0");
    expect(errors).toEqual([]);
  } finally {
    await helper.close();
  }
});
it("spawn failure rejects pending helper work", async () => {
  const failed = deferred<Error>();
  let socketPath: string | undefined;
  const helper = await Helper.open({
    command: "/no-such-screen-helper",
    spawn: (options) => {
      socketPath = options.args?.at(-1)?.replace(/^unix:/, "");
      return spawnSupervised(options);
    },
    nextId: ids(),
    onFrame: () => {},
    onFailure: (error) => failed.resolve(error),
  });
  try {
    await expect(helper.request({ op: "permissions" })).rejects.toThrow();
    expect(await failed.promise).toBeInstanceOf(Error);
  } finally {
    await helper.close();
  }
  if (!socketPath) throw new Error("Missing socket path");
  await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("a liveness deadline terminates a silent helper and rejects outstanding work", async () => {
  const callbacks = new Set<() => void>();
  const failed = deferred<Error>();
  const helper = await Helper.open({
    command: process.execPath,
    args: ["-e", "process.stdin.resume()", "--"],
    nextId: ids(),
    scheduler: {
      schedule(callback) {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    },
    onFrame: () => {},
    onFailure: (error) => failed.resolve(error),
  });
  try {
    const request = helper.request({ op: "hello" });
    const rejected = expect(request).rejects.toThrow("timed out");
    for (const callback of callbacks) callback();
    await rejected;
    expect((await failed.promise).message).toContain("timed out");
    await helper.close();
    expect(callbacks.size).toBe(0);
  } finally {
    await helper.close();
  }
});
it("Windows resolves its installed executable and validates local pipe identifiers", () => {
  expect(screenHelperPath("C:\\ace-data", "win32")).toBe(
    "C:\\ace-data\\helpers\\screen\\ace-screen-helper-windows.exe",
  );
  expect(windowsEndpoint("abc-123")).toBe("pipe:\\\\.\\pipe\\ace-screen-abc-123");
  expect(() => windowsEndpoint("../bad")).toThrow();
  expect(() => screenHelperPath("/data", "freebsd")).toThrow();
});
it("v2 negotiates capabilities and receives fragmented frames from a helper-owned endpoint", async () => {
  const f = await v2Helper("win32");
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
  const f = await v2Helper("win32", { BAD_VERSION: "1" });
  try {
    await expect(
      Helper.open({ ...f.options, onFrame: () => {}, onFailure: () => {} }),
    ).rejects.toThrow();
  } finally {
    await f.clean();
  }
});
it("an oversized UTF-8 command is rejected without killing the helper", async () => {
  const f = await v2Helper("win32");
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
