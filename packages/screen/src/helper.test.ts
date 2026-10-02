import { expect, it } from "vitest";
import { Helper, type Frame } from "./index.ts";
import { deferred, fakeCommand, ids, target } from "./testing/support.ts";
it("the supervised helper correlates concurrent commands and receives fragmented binary frames", async () => {
  const received = deferred<Frame>();
  const errors: Error[] = [];
  const helper = await Helper.open({
    ...fakeCommand,
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
  const helper = await Helper.open({
    command: "/no-such-screen-helper",
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
});
