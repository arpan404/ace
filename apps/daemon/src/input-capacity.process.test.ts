import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { SocketInput, type SocketInputLimits } from "./socket-input.ts";
import { Client, fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** A raw ws server whose handlers wait on a gate, so input backs up deterministically. */
async function gated(limits: Partial<SocketInputLimits> = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const input = new SocketInput(limits);
  const clients: Client[] = [];
  const errors: unknown[] = [];
  let frames = 0;
  const checkpoints = new Map<number, () => void>();
  const reached = (target: number) =>
    frames >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => checkpoints.set(target, resolve));
  const open = async () => {
    const connected = once(server, "connection");
    const client = new Client(`ws://127.0.0.1:${address.port}`);
    clients.push(client);
    const opened = once(client.socket, "open");
    const [socket] = await connected;
    if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
    input.listen(
      socket,
      async () => {
        await gate;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" }));
      },
      (error) => errors.push(error),
    );
    socket.on("message", () => {
      frames++;
      checkpoints.get(frames)?.();
    });
    await opened;
    return client;
  };
  cleanups.push(async () => {
    finish?.();
    for (const client of clients) await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { open, reached, errors, release: () => finish?.() };
}

it("a burst far above the pause threshold is delivered in order once handlers drain", async () => {
  const g = await gated();
  const client = await g.open();
  let closed: number | undefined;
  client.socket.on("close", (code) => {
    closed = code;
  });
  // Reconnect replays subscriptions and queued intents in one synchronous burst.
  for (let i = 0; i < 64; i++) client.send({ type: "ping" });
  await g.reached(16);
  g.release();
  for (let i = 0; i < 64; i++) expect(await client.next()).toEqual({ type: "pong" });
  expect(closed).toBeUndefined();
  expect(g.errors).toEqual([]);
});

it("input beyond the global last-resort cap closes the newest sender and the daemon recovers", async () => {
  const g = await gated({ globalBytes: 4 * 1024 * 1024 });
  const first = await g.open();
  const second = await g.open();
  const victim = await g.open();
  const closed = once(victim.socket, "close").then(([code]) => code);
  for (let i = 0; i < 2; i++) first.socket.send(" ".repeat(900 * 1024));
  await g.reached(2);
  for (let i = 0; i < 2; i++) second.socket.send(" ".repeat(900 * 1024));
  await g.reached(4);
  victim.socket.send(" ".repeat(900 * 1024));
  expect(await closed).toBe(4009);
  g.release();
  for (let i = 0; i < 2; i++) {
    expect(await first.next()).toEqual({ type: "pong" });
    expect(await second.next()).toEqual({ type: "pong" });
  }
  // Completed handlers return their bytes: a fresh large frame fits again.
  const recovered = await g.open();
  recovered.socket.send(" ".repeat(900 * 1024));
  expect(await recovered.next()).toEqual({ type: "pong" });
  expect(g.errors).toEqual([]);
});

it("a reconnect burst of subscriptions right after welcome is served without a 4009 close", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  let closed: number | undefined;
  client.socket.on("close", (code) => {
    closed = code;
  });
  for (let i = 0; i < 24; i++)
    client.send({
      type: "subscribe",
      subscriptionId: `s-${i}`,
      scope: { kind: "thread", threadId: f.thread.id },
    });
  client.send({ type: "ping" });
  const delivered: string[] = [];
  for (let i = 0; i < 25; i++) {
    const message = await client.next();
    delivered.push(message.type === "snapshot" ? message.subscriptionId : message.type);
  }
  expect(delivered).toEqual([...Array.from({ length: 24 }, (_, i) => `s-${i}`), "pong"]);
  expect(closed).toBeUndefined();
});
