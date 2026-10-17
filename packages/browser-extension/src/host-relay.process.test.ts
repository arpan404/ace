import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.ts";
import { relayNativeHost } from "./host-relay.ts";

/** A stand-in for the daemon's socket: answers hello, records what the host relays. */
async function fakeDaemon(token = "a".repeat(64)) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  await once(server, "listening");
  const received: unknown[] = [];
  const hellos: unknown[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; token?: string };
      if (message.type === "hello") {
        hellos.push(message);
        if (message.token === token) socket.send(JSON.stringify({ type: "welcome" }));
        else {
          socket.send(JSON.stringify({ type: "error", code: "unauthorized" }));
          socket.close(4001, "unauthorized");
        }
      } else if (message.type !== "ping") received.push(message);
    });
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, received, hellos, sockets };
}

/** Chrome's side of the native port. */
function extensionPort() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new NativeMessageDecoder(1024 * 1024);
  const messages: unknown[] = [];
  output.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
  return {
    input,
    output,
    messages,
    send: (message: unknown) => input.write(encodeNativeMessage(message, 64 << 20)),
  };
}

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 400 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

function start(
  daemon: Awaited<ReturnType<typeof fakeDaemon>>,
  port: ReturnType<typeof extensionPort>,
  token = "a".repeat(64),
) {
  servers.push(daemon.server);
  return relayNativeHost({
    input: port.input,
    output: port.output,
    endpoint: async () => daemon.origin,
    credential: async () => ({ deviceId: "host-device", token }),
    open: (url) => new WebSocket(url),
    // Backoff and keepalive run on a short clock so reconnects are observable quickly.
    delay: (milliseconds, work) => {
      const timer = setTimeout(work, Math.min(milliseconds, 30));
      return () => clearTimeout(timer);
    },
    log: () => {},
  });
}
const register = {
  type: "user_browser.register",
  requestId: "r1",
  version: 1,
  browser: { family: "chrome", version: "155", profileId: "p1", extensionVersion: "0.1.0" },
};

test("the host authenticates with its credential, then relays user_browser messages both ways", async () => {
  const daemon = await fakeDaemon();
  const port = extensionPort();
  void start(daemon, port);
  await until(() => port.messages.some((m) => (m as { state?: string }).state === "connected"));
  expect(daemon.hellos).toEqual([
    { type: "hello", protocolVersion: 1, deviceId: "host-device", token: "a".repeat(64) },
  ]);
  // Not a user_browser message: never reaches the daemon.
  port.send({ type: "command", command: { anything: true } });
  port.send(register);
  await until(() => daemon.received.length === 1);
  expect(daemon.received).toEqual([register]);
  const command = { type: "user_browser.command", id: "7", operation: { op: "tabs.list" } };
  daemon.sockets[0]?.send(JSON.stringify(command));
  // A daemon message outside the extension protocol is not passed on either.
  daemon.sockets[0]?.send(JSON.stringify({ type: "browser.frame" }));
  await until(() =>
    port.messages.some((m) => (m as { type: string }).type === "user_browser.command"),
  );
  expect(port.messages.filter((m) => (m as { type: string }).type !== "user_browser.link")).toEqual(
    [command],
  );
});

test("a reply too large for the daemon socket arrives as an error so its command still settles", async () => {
  const daemon = await fakeDaemon();
  const port = extensionPort();
  void start(daemon, port);
  await until(() => port.messages.some((m) => (m as { state?: string }).state === "connected"));
  port.send({
    type: "user_browser.reply",
    id: "9",
    ok: true,
    result: { data: "x".repeat(2 << 20) },
  });
  port.send({
    type: "user_browser.event",
    event: {
      kind: "cdp",
      tabId: 1,
      method: "Page.screencastFrame",
      params: { data: "y".repeat(2 << 20) },
    },
  });
  port.send({ type: "user_browser.reply", id: "10", ok: true, result: null });
  await until(() => daemon.received.length === 2);
  expect(daemon.received).toEqual([
    { type: "user_browser.reply", id: "9", ok: false, error: expect.stringContaining("larger") },
    { type: "user_browser.reply", id: "10", ok: true, result: null },
  ]);
});

test("when the daemon goes away the extension hears it, and the host reconnects on its own", async () => {
  const daemon = await fakeDaemon();
  const port = extensionPort();
  void start(daemon, port);
  await until(() => daemon.sockets.length === 1 && port.messages.length > 1);
  daemon.sockets[0]?.terminate();
  await until(() => daemon.hellos.length === 2);
  const states = port.messages.map((m) => (m as { state?: string }).state);
  expect(states).toEqual(["connecting", "connected", "unavailable", "connecting", "connected"]);
});

test("a refused credential is reported as unauthorized, not as ace being down", async () => {
  const daemon = await fakeDaemon();
  const port = extensionPort();
  void start(daemon, port, "b".repeat(64));
  await until(() => port.messages.some((m) => (m as { state?: string }).state === "unauthorized"));
});

test("closing the extension port ends the host and its daemon connection", async () => {
  const daemon = await fakeDaemon();
  const port = extensionPort();
  const done = start(daemon, port);
  await until(
    () => daemon.sockets.length === 1 && daemon.sockets[0]?.readyState === WebSocket.OPEN,
  );
  const closed = once(daemon.sockets[0] as WebSocket, "close");
  port.input.end();
  await done;
  await closed;
});
