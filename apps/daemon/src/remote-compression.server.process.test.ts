import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { Agent, AgentId, Item, ServerMessage } from "@ace/protocol";
import type { WebSocket } from "ws";
import { ticketSocket } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";

const root = AgentId.parse("root");
type Fixture = Awaited<ReturnType<typeof setup>>;

/** A thread whose snapshot is a few hundred KiB of ordinary, repetitive agent text. */
function seedLongReply(f: Fixture): string {
  const text = Array.from(
    { length: 4000 },
    (_, line) => `  const value${line % 50} = await readConfig(path, { strict: true });`,
  ).join("\n");
  f.store.appendEvents(f.thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: root,
        threadId: f.thread.id,
        parentId: null,
        origin: "root",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: f.home,
        status: { state: "idle" },
        createdAt: 10,
      }),
    },
    {
      type: "item.created",
      item: Item.parse({
        id: "reply",
        agentId: root,
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text }],
        createdAt: 11,
        complete: true,
      }),
    },
  ]);
  return text;
}

/** A paired device's pinned WSS socket, plus the bytes its TLS connection has read. */
async function remoteSocket(f: Fixture) {
  const paired = await f.pair();
  const issued = await f.ticket(paired.token);
  const socket = ticketSocket(f.server.remoteUrl, identity.fingerprint);
  const closed = once(socket, "close");
  cleanups.push(async () => {
    if (socket.readyState !== socket.CLOSED) socket.close();
    await closed;
  });
  // `ws` emits open in the same tick as upgrade, so listen for both first.
  const opened = once(socket, "open");
  const [response] = (await once(socket, "upgrade")) as [IncomingMessage];
  await opened;
  const messages = receiver(socket);
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: issued.ticket,
    }),
  );
  expect(await messages.next()).toMatchObject({ type: "welcome" });
  return { socket, messages, bytesRead: () => response.socket.bytesRead };
}

function receiver(socket: WebSocket) {
  const queue: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  socket.on("message", (data) => {
    const message = ServerMessage.parse(JSON.parse(String(data)));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  return {
    next: () =>
      new Promise<ServerMessage>((resolve) => {
        const queued = queue.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      }),
  };
}

describe("socket compression", () => {
  it("delivers a large thread to a remote device intact in far fewer bytes", async () => {
    const f = await setup();
    const text = seedLongReply(f);
    const remote = await remoteSocket(f);
    expect(remote.socket.extensions).toContain("permessage-deflate");
    const before = remote.bytesRead();
    remote.socket.send(
      JSON.stringify({
        type: "subscribe",
        subscriptionId: "thread",
        scope: { kind: "thread", threadId: f.thread.id },
      }),
    );
    const snapshot = await remote.messages.next();
    expect(JSON.stringify(snapshot)).toContain(JSON.stringify(text).slice(1, -1));
    expect(remote.bytesRead() - before).toBeLessThan(text.length / 4);
  });

  it("keeps loopback sockets uncompressed", async () => {
    const f = await setup();
    const client = await f.connect();
    expect((await client.next()).type).toBe("welcome");
    expect(client.socket.extensions).toBe("");
  });

  it("closes a remote socket whose message inflates past the payload limit", async () => {
    const f = await setup();
    const remote = await remoteSocket(f);
    const closed = once(remote.socket, "close");
    // About 2 KiB on the wire, 2 MiB once inflated: twice the daemon's message limit.
    remote.socket.send(JSON.stringify({ type: "ping", pad: "a".repeat(2 * 1024 * 1024) }));
    const [code] = (await closed) as [number];
    expect(code).toBe(1009);
  });
});
