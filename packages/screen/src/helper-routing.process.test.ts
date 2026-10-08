import { expect, it, onTestFinished } from "vitest";
import { ScreenUIFindResult } from "@ace/protocol";
import { Helper } from "./index.ts";
import { helperGate } from "./testing/gate.ts";
import { fakeCommand, ids, target } from "./testing/support.ts";

it("an independent app can be observed while a native read is pending and takeover cancels its own queued input", async () => {
  const gate = await helperGate();
  const helper = await Helper.open({
    ...fakeCommand,
    env: { FAKE_V2: "1", READ_GATE_PORT: gate.port },
    nextId: ids(),
    onFrame: () => {},
    onFailure: () => {},
  });
  onTestFinished(async () => {
    gate.release();
    await helper.close();
    await gate.close();
  });
  await helper.negotiate();
  await helper.request({
    op: "start",
    sessionId: "a",
    target,
    allowlist: [target.bundleId],
    fps: 10,
    capture: false,
  });
  const other = { ...target, bundleId: "dev.ace.other", windowId: 2 };
  await helper.request({
    op: "start",
    sessionId: "b",
    target: other,
    allowlist: [other.bundleId],
    fps: 10,
    capture: false,
  });
  const read = helper.request({
    op: "ui.tree",
    sessionId: "a",
    target,
    allowlist: [target.bundleId],
    maxNodes: 8,
    maxDepth: 2,
  });
  await gate.reached;
  let authorized = true;
  const queued = expect(
    helper.request(
      { op: "input", sessionId: "a", input: { kind: "text.type", text: "stale" } },
      () => {
        if (!authorized) throw new Error("Controller changed");
      },
    ),
  ).rejects.toThrow("Controller changed");
  const independent = ScreenUIFindResult.parse(
    await helper.request({
      op: "ui.find",
      sessionId: "b",
      target: other,
      allowlist: [other.bundleId],
      query: { name: "Changes" },
      limit: 1,
    }),
  );
  expect(independent.nodes[0]?.value).toBe("0");
  authorized = false;
  gate.release();
  await read;
  await queued;
  const unchanged = ScreenUIFindResult.parse(
    await helper.request({
      op: "ui.find",
      sessionId: "a",
      target,
      allowlist: [target.bundleId],
      query: { name: "Changes" },
      limit: 1,
    }),
  );
  expect(unchanged.nodes[0]?.value).toBe("0");
});
