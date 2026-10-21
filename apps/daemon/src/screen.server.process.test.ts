import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { ScreenState, ServerMessage } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import {
  decodeStreamMessage,
  isStreamPiece,
  StreamAssembler,
  type StreamMessage,
} from "@ace/browser/stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, token } from "./socket-test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it("authenticated devices receive visible screen state and stream pictures and disconnect relinquishes control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daemon-screen-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    // A Mac helper that encodes H.264: live views are video only.
    env: { FAKE_V2: "1", FAKE_VIDEO: "1" },
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
  type Picture = Extract<StreamMessage, { kind: "screen.frame" }>;
  const frames: Picture[] = [];
  const waiting = new Map<string, (message: ServerMessage) => void>();
  let frameResolve: (value: Picture) => void = ignore;
  const frameReady = new Promise<Picture>((resolve) => {
    frameResolve = resolve;
  });
  const assembler = new StreamAssembler();
  let foreign = 0;
  socket.on("message", (data, binary) => {
    if (binary) {
      if (!Buffer.isBuffer(data)) throw new Error("Expected binary Buffer");
      // Every binary message is a stream piece: nothing else reaches a viewer.
      if (!isStreamPiece(data)) return void foreign++;
      const envelope = assembler.push(data);
      const message = envelope && decodeStreamMessage(envelope);
      if (message?.kind === "screen.frame") {
        frames.push(message);
        frameResolve(message);
      }
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
  const started = await request({
    op: "start",
    target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 },
  });
  if (started.type !== "screen.result") throw new Error("Expected screen result");
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  const state = ScreenState.parse(started.data);
  await request({ op: "subscribe", sessionId: state.sessionId });
  expect(
    await request({
      op: "stream.configure",
      sessionId: state.sessionId,
      settings: { codec: "h264", maxWidth: 1280, maxHeight: 800, fps: 60, bitrate: 8_000_000 },
    }),
  ).toMatchObject({ ok: true, data: { codec: "h264" } });
  await request({ op: "controller", sessionId: state.sessionId, controller: "human" });
  expect(
    await request({
      op: "action",
      sessionId: state.sessionId,
      action: { kind: "type", text: "hello" },
    }),
  ).toMatchObject({ ok: true });
  expect((await frameReady).sourceId).toBe(state.sessionId);
  // The session's stills never reached the viewer: only its video did.
  expect(frames.every((frame) => frame.frame.codec !== "jpeg")).toBe(true);
  expect(foreign).toBe(0);
  // The viewer's ack is taken without a reply.
  socket.send(
    JSON.stringify({
      type: "screen.ack",
      sessionId: state.sessionId,
      streamId: frames[0]?.frame.streamId,
      sequence: frames[0]?.frame.sequence,
    }),
  );
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
      requestId: "start",
      operation: { op: "start", target: { kind: "window", bundleId: "dev.ace.test", windowId: 1 } },
    }),
  );

  await expect.poll(() => main.types.includes("screen.state"), { timeout: 10_000 }).toBe(true);
  // A round trip on the devices channel: anything pushed to it before now has arrived.
  devices.socket.send(JSON.stringify({ type: "ping" }));
  await expect.poll(() => devices.types.includes("pong"), { timeout: 10_000 }).toBe(true);
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
