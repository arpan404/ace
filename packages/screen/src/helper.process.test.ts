import { access } from "node:fs/promises";
import { spawnSupervised } from "@ace/provider-kit/process";
import { expect, it } from "vitest";
import { Helper, type Frame } from "./index.ts";
import { deferred, fakeCommand, ids, target } from "./testing/support.ts";
it("the supervised helper correlates concurrent commands and receives fragmented binary frames", async () => {
  const received = deferred<Frame>();
  const errors: Error[] = [];
  const helper = await Helper.open({
    ...fakeCommand,
    env: { REVERSE_REPLIES: "1" },
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
it("an injected command deadline terminates a silent helper and rejects outstanding work", async () => {
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
    const request = helper.request({ op: "permissions" });
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
