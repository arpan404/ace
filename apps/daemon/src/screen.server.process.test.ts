import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { ScreenFrameHeader, ScreenState, ServerMessage } from "@ace/protocol";
import { FrameDecoder, ScreenManager, type Frame } from "@ace/screen";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, token } from "./socket-test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it("authenticated devices receive visible screen state and binary frames and disconnect relinquishes control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daemon-screen-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    nextId: () => `id-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  cleanups.push(async () => {
    await screen.close();
    await rm(directory, { recursive: true, force: true });
  });
  const f = await fixture({ screen });
  cleanups.push(f.close);
  const socket = new WebSocket(f.server.url);
  await once(socket, "open");
  const messages: ServerMessage[] = [];
  const frames: Frame[] = [];
  const waiting = new Map<string, (message: ServerMessage) => void>();
  let frameResolve: (value: Frame) => void = ignore;
  const frameReady = new Promise<Frame>((resolve) => {
    frameResolve = resolve;
  });
  socket.on("message", (data, binary) => {
    if (binary) {
      const decoder = new FrameDecoder((frame) => {
        frames.push(frame);
        frameResolve(frame);
      });
      if (!Buffer.isBuffer(data)) throw new Error("Expected binary Buffer");
      decoder.push(data);
      decoder.end();
    } else {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      messages.push(message);
      if (message.type === "screen.result") waiting.get(message.requestId)?.(message);
    }
  });
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, token, deviceId: "device" }));
  let requestId = 0;
  const request = (operation: unknown) =>
    new Promise<ServerMessage>((resolve) => {
      const requestIdString = `req-${++requestId}`;
      waiting.set(requestIdString, resolve);
      socket.send(
        JSON.stringify({ type: "screen.request", requestId: requestIdString, operation }),
      );
    });
  expect(await request({ op: "enable", enabled: true })).toMatchObject({ ok: true });
  expect(await request({ op: "approve", bundleId: "dev.ace.test", allowed: true })).toMatchObject({
    ok: true,
  });
  const started = await request({
    op: "start",
    target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 },
  });
  if (started.type !== "screen.result") throw new Error("Expected screen result");
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  const state = ScreenState.parse(started.data);
  await request({ op: "subscribe", sessionId: state.sessionId });
  await request({ op: "controller", sessionId: state.sessionId, controller: "human" });
  expect(
    await request({
      op: "action",
      sessionId: state.sessionId,
      action: { kind: "type", text: "hello" },
    }),
  ).toMatchObject({ ok: true });
  expect(ScreenFrameHeader.parse((await frameReady).header).sessionId).toBe(state.sessionId);
  expect(frames[0]?.payload.toString()).toBe("jpeg-0");
  expect(
    messages.some(
      (message) =>
        message.type === "screen.state" &&
        message.state.indicator &&
        message.state.controller === "human",
    ),
  ).toBe(true);
  const released = new Promise<void>((resolve) => {
    screen.watch((value) => {
      if (value.controller === "none") resolve();
    });
  });
  const closed = once(socket, "close");
  socket.close();
  await closed;
  await released;
  expect(screen.state(state.sessionId).controller).toBe("none");
});
it("screen state reaches the main channel only, never a devices channel that can't parse it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daemon-screen-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    nextId: () => `id-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  cleanups.push(async () => {
    await screen.close();
    await rm(directory, { recursive: true, force: true });
  });
  const f = await fixture({ screen });
  cleanups.push(f.close);
  const open = async (channel?: "devices") => {
    const socket = new WebSocket(f.server.url);
    await once(socket, "open");
    const types: string[] = [];
    socket.on("message", (data, binary) => {
      if (!binary) types.push(String(JSON.parse(data.toString()).type));
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        token,
        deviceId: "device",
        ...(channel ? { channel } : {}),
      }),
    );
    cleanups.push(async () => {
      socket.close();
    });
    await expect.poll(() => types.includes("welcome"), { timeout: 10_000 }).toBe(true);
    return { socket, types };
  };
  const main = await open();
  const devices = await open("devices");

  main.socket.send(
    JSON.stringify({
      type: "screen.request",
      requestId: "enable",
      operation: { op: "enable", enabled: true },
    }),
  );
  main.socket.send(
    JSON.stringify({
      type: "screen.request",
      requestId: "approve",
      operation: { op: "approve", bundleId: "dev.ace.test", allowed: true },
    }),
  );
  main.socket.send(
    JSON.stringify({
      type: "screen.request",
      requestId: "start",
      operation: { op: "start", target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 } },
    }),
  );

  await expect.poll(() => main.types.includes("screen.state"), { timeout: 10_000 }).toBe(true);
  expect(devices.types.filter((type) => type.startsWith("screen."))).toEqual([]);
});

it("unauthenticated clients cannot enable screen access", async () => {
  const f = await fixture();
  cleanups.push(f.close);
  const client = await f.open();
  const closed = once(client.socket, "close");
  client.socket.send(
    JSON.stringify({
      type: "screen.request",
      requestId: "enable",
      operation: { op: "enable", enabled: true },
    }),
  );
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  expect((await closed)[0]).toBe(4001);
});

function ignore() {}
