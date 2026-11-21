import { afterEach, expect, it } from "vitest";
import { computerUseHandler, screenConnection, Simulators } from "./index.ts";
import { manager, ready } from "./testing/support.ts";
import { fakeDelivery, phoneOwner } from "@ace/media/testing/fake-delivery";
import { ScreenState, type ScreenServerMessage } from "@ace/protocol";
import { updateReason } from "@ace/media/media-viewers";
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
  });
  const b = screenConnection(test.screen, new Simulators("linux"), "human-b", {
    send: (message) => second.push(message),
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

it("an older client's subscribe gets no pictures and its session's error asks it to update", async () => {
  const test = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const messages: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => messages.push(message),
    delivery: { owner: () => phoneOwner, port: () => fakeDelivery().port },
  });
  cleanups.push(async () => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "watch",
    operation: { op: "subscribe", sessionId: state.sessionId },
  });
  const reply = messages.find(
    (message) => message.type === "screen.result" && message.requestId === "watch",
  );
  // An older client can't read `undelivered`: the session's state says why in `error`, which it
  // already shows.
  const told = messages.findLast((message) => message.type === "screen.state");
  expect(told?.type === "screen.state" && ScreenState.parse(told.state).error).toBe(updateReason);
  expect(reply).toMatchObject({ ok: true, undelivered: { code: "update" } });
  expect(reply).not.toHaveProperty("media");
  // Acks are the media connection's now: one here is read and changes nothing.
  const before = messages.length;
  connection.ack({ type: "screen.ack", sessionId: state.sessionId, streamId: "s", sequence: 1 });
  expect(messages.length).toBe(before);
  expect(() => connection.ack({ type: "screen.ack", sessionId: state.sessionId })).toThrow();
});

it("a subscribe naming a media connection while ace-media can't serve screens says why", async () => {
  const test = await manager({ FAKE_V2: "1", FAKE_VIDEO: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const messages: ScreenServerMessage[] = [];
  const delivery = fakeDelivery();
  const port = {
    ...delivery.port,
    serves: () => false,
    unserved: () => "Live video is starting. It shows in a moment.",
  };
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => messages.push(message),
    delivery: { owner: () => phoneOwner, port: () => port },
  });
  cleanups.push(async () => connection.close());
  await connection.request({
    type: "screen.request",
    requestId: "watch",
    operation: {
      op: "subscribe",
      sessionId: state.sessionId,
      media: { connection: "mc_phoneconnection1" },
      mediaClient: true,
    },
  });
  expect(
    messages.find((message) => message.type === "screen.result" && message.requestId === "watch"),
  ).toMatchObject({
    ok: true,
    undelivered: { code: "unavailable", reason: "Live video is starting. It shows in a moment." },
  });
});

it("a request it can't read is refused at once rather than left unanswered", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const sent: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human", {
    send: (message) => sent.push(message),
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

it("a resubscribe on the same media connection that fails keeps delivering on the view it had", async () => {
  const test = await manager({ FAKE_V2: "1" });
  cleanups.push(test.close);
  const state = await ready(test.screen);
  const d = fakeDelivery();
  const failing = { on: false };
  const results: ScreenServerMessage[] = [];
  const connection = screenConnection(test.screen, new Simulators("linux"), "human-1", {
    send: (message) => results.push(message),
    delivery: { owner: () => phoneOwner, port: () => d.port },
    // What the session runs on, read for the state a subscribe answers with: failing here
    // fails the subscribe after its view was granted.
    acceleration: {
      for: () => {
        if (failing.on) throw new Error("acceleration store gone");
        return undefined;
      },
      watch: () => () => {},
    },
  });
  cleanups.push(async () => connection.close());
  const subscribe = (requestId: string) =>
    connection.request({
      type: "screen.request",
      requestId,
      operation: {
        op: "subscribe",
        sessionId: state.sessionId,
        media: { connection: "mc_aaaaaaaaaaaa" },
      },
    });
  await subscribe("first");
  const [first] = d.live;
  expect(first).toBeDefined();
  failing.on = true;
  await subscribe("again");
  failing.on = false;
  expect(results.at(-1)).toMatchObject({ type: "screen.result", requestId: "again", ok: false });
  // Its new view replaced the old one in ace-media, then was undone: the old one delivers again.
  expect([...d.live]).toEqual([first]);
  expect(d.views.size).toBe(1);
  // The subscription still holds it: leaving closes it.
  await connection.request({
    type: "screen.request",
    requestId: "leave",
    operation: { op: "unsubscribe", sessionId: state.sessionId },
  });
  expect(d.live.size).toBe(0);
  expect(d.views.size).toBe(0);
});
