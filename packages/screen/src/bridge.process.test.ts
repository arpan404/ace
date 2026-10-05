import { afterEach, expect, it } from "vitest";
import { computerUseHandler, screenConnection, Simulators } from "./index.ts";
import { manager, ready } from "./testing/support.ts";
import type { ScreenServerMessage } from "@ace/protocol";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it("human devices can discover sessions, delegate to a scoped agent and observe takeover without subscribing to frames", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const messages: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => messages.push(message),
    frame: async () => {},
  });
  cleanups.push(async () => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "list",
    operation: { op: "sessions" },
  });
  expect(messages.at(-1)).toMatchObject({ type: "screen.result", ok: true, data: [state] });
  await connection.request({
    type: "screen.request",
    requestId: "delegate",
    operation: {
      op: "controller",
      sessionId: state.sessionId,
      controller: "agent",
      agentId: "agent-1",
    },
  });
  const tool = computerUseHandler(test.screen, state.sessionId, "agent-1");
  await tool("screen_type", { text: "hello" });
  await connection.request({
    type: "screen.request",
    requestId: "takeover",
    operation: { op: "controller", sessionId: state.sessionId, controller: "human" },
  });
  expect(
    messages.some(
      (message) => message.type === "screen.state" && message.state.controller === "human",
    ),
  ).toBe(true);
  await expect(tool("screen_type", { text: "hello" })).rejects.toThrow("ownership");
  connection.close();
  expect(test.screen.state(state.sessionId).controller).toBe("none");
});
it("a disconnect while start is in progress closes the resulting capture", async () => {
  const test = await manager();
  cleanups.push(test.close);
  await test.screen.enable(true);
  await test.screen.approve("dev.ace.test", true);
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: () => {},
    frame: async () => {},
  });
  const request = connection.request({
    type: "screen.request",
    requestId: "start",
    operation: { op: "start", target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 } },
  });
  connection.close();
  await request;
  expect(test.screen.states()).toEqual([]);
});
