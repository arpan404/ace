import { afterEach, expect, it } from "vitest";
import { computerUseHandler, screenConnection, Simulators } from "./index.ts";
import { manager, ready } from "./testing/support.ts";
import type { ScreenServerMessage } from "@ace/protocol";
import {
  decodeStreamMessage,
  isStreamPiece,
  StreamAssembler,
  type StreamMessage,
} from "@ace/browser/stream";
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
    media: { write: async () => {}, bufferedBytes: () => 0 },
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
      threadId: "thread-1",
    },
  });
  const tool = computerUseHandler(
    test.screen,
    state.sessionId,
    JSON.stringify(["thread-1", "agent-1"]),
  );
  await tool("screen_input", { action: "type", text: "hello" });
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
  await expect(tool("screen_input", { action: "type", text: "hello" })).rejects.toThrow(
    "ownership",
  );
  connection.close();
  expect(test.screen.state(state.sessionId).controller).toBe("none");
});
it("a disconnect while start is in progress closes the resulting capture", async () => {
  const test = await manager();
  cleanups.push(test.close);
  await test.screen.enable(true);
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: () => {},
    media: { write: async () => {}, bufferedBytes: () => 0 },
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
it("status exposes enablement without sessions and changes reach every human connection", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const first: ScreenServerMessage[] = [],
    second: ScreenServerMessage[] = [];
  const a = screenConnection(test.screen, new Simulators("linux"), "human-a", {
    send: (message) => first.push(message),
    media: { write: async () => {}, bufferedBytes: () => 0 },
  });
  const b = screenConnection(test.screen, new Simulators("linux"), "human-b", {
    send: (message) => second.push(message),
    media: { write: async () => {}, bufferedBytes: () => 0 },
  });
  cleanups.push(async () => {
    a.close();
    b.close();
  });
  const request = (operation: unknown) =>
    a.request({ type: "screen.request", requestId: "settings", operation });
  await request({ op: "status" });
  expect(first.at(-1)).toMatchObject({
    type: "screen.result",
    ok: true,
    data: {
      enabled: false,
      sessions: 0,
      permissions: { screenRecording: false, accessibility: false },
    },
  });
  await request({ op: "enable", enabled: true });
  expect(second.at(-1)).toEqual({ type: "screen.enabled", enabled: true });
  await request({ op: "permissions.request", permission: "accessibility" });
  expect(first.at(-1)).toMatchObject({
    type: "screen.result",
    ok: true,
    data: { accessibility: true },
  });
  await request({ op: "status" });
  expect(first.at(-1)).toMatchObject({ data: { enabled: true, sessions: 0 } });
  await request({ op: "stop.all" });
  expect(second.at(-1)).toEqual({ type: "screen.enabled", enabled: false });
  a.close();
  await test.screen.enable(true);
  expect(first.at(-1)).toMatchObject({ type: "screen.result", ok: true });
  expect(second.at(-1)).toEqual({ type: "screen.enabled", enabled: true });
});

it("an enablement observer cannot prevent the global stop from releasing live targets", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  await ready(test.screen);
  const release = test.screen.watchEnabled(() => {
    throw new Error("Disconnected observer");
  });
  await test.screen.stopAll();
  expect(test.screen.isEnabled()).toBe(false);
  expect(test.screen.states()).toEqual([]);
  release();
});

it("a subscribed session's pictures arrive as stream kind screenFrame, named by the session", async () => {
  const test = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const assembler = new StreamAssembler();
  const pictures: StreamMessage[] = [];
  const first = Promise.withResolvers<void>();
  const messages: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => messages.push(message),
    media: {
      bufferedBytes: () => 0,
      write: async (piece) => {
        // Every binary message is a stream piece: no other framing reaches a viewer.
        expect(isStreamPiece(piece)).toBe(true);
        const envelope = assembler.push(piece);
        const message = envelope && decodeStreamMessage(envelope);
        if (message) pictures.push(message);
        first.resolve();
      },
    },
  });
  cleanups.push(async () => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "watch",
    operation: { op: "subscribe", sessionId: state.sessionId },
  });
  // Live views are video only: the session's stills never reach the viewer until it asks.
  await connection.request({
    type: "screen.request",
    requestId: "video",
    operation: {
      op: "stream.configure",
      sessionId: state.sessionId,
      settings: { codec: "h264", maxWidth: 1280, maxHeight: 800, fps: 60, bitrate: 8_000_000 },
    },
  });
  await first.promise;
  const [picture] = pictures;
  expect(
    pictures.every((message) => message.kind !== "screen.frame" || message.frame.codec !== "jpeg"),
  ).toBe(true);
  expect(picture?.kind).toBe("screen.frame");
  if (picture?.kind !== "screen.frame") return;
  expect(picture.sourceId).toBe(state.sessionId);
  expect(picture.frame.key).toBe(true);
  // An ack is never answered; a malformed one is refused.
  const before = messages.length;
  connection.ack({
    type: "screen.ack",
    sessionId: state.sessionId,
    streamId: picture.frame.streamId,
    sequence: picture.frame.sequence,
  });
  expect(messages.length).toBe(before);
  expect(() => connection.ack({ type: "screen.ack", sessionId: state.sessionId })).toThrow();
});

it("a request it can't read is refused at once rather than left unanswered", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const sent: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human", {
    send: (message) => sent.push(message),
    media: { write: async () => {}, bufferedBytes: () => 0 },
  });
  cleanups.push(async () => connection.close());
  await expect(
    connection.request({
      type: "screen.request",
      requestId: "click",
      operation: { op: "input", sessionId: "s", input: { kind: "pointer.click", x: -5, y: 1 } },
    }),
  ).rejects.toThrow();
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "screen.result",
      requestId: "click",
      ok: false,
      errorCode: "bounds",
    }),
  );
});
