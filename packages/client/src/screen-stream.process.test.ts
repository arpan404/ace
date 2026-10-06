import { expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientMessage,
  ScreenState,
  type ScreenClientMessage,
  type ServerMessage,
} from "@ace/protocol";
import { keyPair } from "@ace/secure-channel";
import {
  ScreenStreamClient,
  screenTransport,
  type ScreenTransport,
  type PortableFrame,
} from "./screen-stream.ts";

const state = ScreenState.parse({
  sessionId: "app",
  lifecycle: "live",
  controller: "none",
  indicator: false,
  target: { kind: "app", bundleId: "com.apple.calculator" },
  permissions: { screenRecording: true, accessibility: true },
});
function packet(): Uint8Array {
  const payload = new Uint8Array([255, 216, 255, 217]);
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      sessionId: "app",
      sequence: 1,
      timestamp: 1000,
      width: 1,
      height: 1,
      codec: "jpeg",
      bytes: payload.length,
    }),
  );
  const frame = new Uint8Array(4 + header.length + payload.length);
  new DataView(frame.buffer).setUint32(0, header.length);
  frame.set(header, 4);
  frame.set(payload, header.length + 4);
  return frame;
}
const schedule = (callback: () => void, delay: number) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};
function ready(client: ScreenStreamClient): Promise<void> {
  if (client.getSnapshot().connected) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = client.watch((snapshot) => {
      if (snapshot.connected) {
        stop();
        resolve();
      }
    });
  });
}

function transport() {
  let events: Parameters<ScreenTransport["open"]>[0] | undefined;
  const sent: ReturnType<typeof ScreenClientMessage.parse>[] = [];
  const connection: ScreenTransport = {
    open: (next) => {
      events = next;
      next.ready();
    },
    send: (message) => {
      sent.push(message);
    },
    close: () => {},
  };
  return {
    connection,
    sent,
    receive: (message: ServerMessage | Uint8Array) => events?.message(message),
  };
}

it("authenticates a dedicated screen socket and correlates results while decoding fragmented live frames", async () => {
  const server = new WebSocketServer({ port: 0 });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const hello = Promise.withResolvers<unknown>();
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const request = ClientMessage.parse(JSON.parse(raw.toString()));
      if (request.type === "hello") {
        hello.resolve(request);
        socket.send(
          JSON.stringify({ type: "welcome", protocolVersion: 1, hostId: "host", headSeq: 0 }),
        );
      } else if (request.type === "screen.request") {
        if (request.operation.op === "sessions") {
          socket.send(
            JSON.stringify({
              type: "screen.result",
              requestId: request.requestId,
              ok: true,
              data: [state],
            }),
          );
        } else if (request.operation.op === "subscribe") {
          socket.send(JSON.stringify({ type: "screen.state", state }));
          const frame = packet();
          socket.send(frame.subarray(0, 9));
          socket.send(frame.subarray(9));
          socket.send(
            JSON.stringify({ type: "screen.result", requestId: request.requestId, ok: true }),
          );
        } else
          socket.send(
            JSON.stringify({
              type: "screen.result",
              requestId: request.requestId,
              ok: false,
              errorCode: "foreground_required",
              error: "App ignores background input",
            }),
          );
      }
    }),
  );
  let id = 0;
  const client = new ScreenStreamClient({ id: () => `request-${++id}`, schedule });
  onTestFinished(() => client.disconnect());
  client.connect(
    screenTransport({
      target: { kind: "local", url: `ws://127.0.0.1:${address.port}/` },
      deviceId: "owner",
      credential: async () => "a".repeat(64),
      socket: (url) => new WebSocket(url),
      schedule,
      keys: () => ({
        staticKey: keyPair(new Uint8Array(32).fill(3)),
        ephemeralKey: keyPair(new Uint8Array(32).fill(4)),
      }),
    }),
  );
  expect(await hello.promise).toMatchObject({ channel: "screen", deviceId: "owner" });
  await ready(client);
  expect(client.getSnapshot().states).toEqual([]);
  expect(await client.request({ op: "sessions" })).toEqual([state]);
  expect(client.getSnapshot().states).toEqual([state]);
  const received = Promise.withResolvers<PortableFrame>();
  const stop = client.watchFrames("app", (frame) => received.resolve(frame));
  onTestFinished(stop);
  await client.request({ op: "subscribe", sessionId: "app" });
  expect((await received.promise).payload).toEqual(new Uint8Array([255, 216, 255, 217]));
  expect(client.getSnapshot().states).toEqual([state]);
  await expect(
    client.request({
      op: "input",
      sessionId: "app",
      input: { kind: "text.type", text: "scratch" },
    }),
  ).rejects.toMatchObject({ errorCode: "foreground_required" });
});

it("screen disconnects reject outstanding commands and stale callbacks cannot complete a reconnect's requests", async () => {
  let id = 0;
  const timers = new Set<() => void>();
  const client = new ScreenStreamClient({
    id: () => `request-${++id}`,
    schedule: (callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  onTestFinished(() => client.disconnect());

  const old = transport();
  client.connect(old.connection);
  const pending = expect(client.request({ op: "sessions" })).rejects.toThrow("closed");
  client.disconnect();
  await pending;
  const next = transport();
  client.connect(next.connection);
  const timed = expect(client.request({ op: "sessions" })).rejects.toMatchObject({
    errorCode: "timeout",
  });
  old.receive({ type: "screen.state", state });
  old.receive({ type: "screen.enabled", enabled: true });
  expect(client.getSnapshot()).toMatchObject({ connected: true, states: [] });
  expect(client.getSnapshot().enabled).toBeUndefined();
  for (const callback of timers) callback();
  await timed;
  expect(next.sent).toHaveLength(1);
  const malformed = expect(client.request({ op: "sessions" })).rejects.toThrow();
  next.receive(new Uint8Array([255, 255, 255, 255]));
  await malformed;
  expect(client.getSnapshot().connected).toBe(false);
});
