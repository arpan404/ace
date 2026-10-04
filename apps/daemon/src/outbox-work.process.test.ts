import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { Event, ServerMessage } from "@ace/protocol";
import { PluginServerMessage } from "@ace/protocol/plugins";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import { Outbox, defaultPressure } from "./outbox.ts";
import { Client } from "./socket-test-support.ts";

it("delivers plugin control results after queued events and preserves subsequent control messages", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const received: unknown[] = [];
  const delivered = Promise.withResolvers<void>();
  const response = z.union([ServerMessage, PluginServerMessage]);
  client.on("message", (data) => {
    try {
      received.push(response.parse(JSON.parse(data.toString())));
      if (received.length === 3) delivered.resolve();
    } catch (error) {
      delivered.reject(error);
    }
  });
  const opened = once(client, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
  await opened;
  try {
    const outbox = new Outbox(socket, { ...defaultPressure, softLimit: -1 });
    const event = Event.parse({
      seq: 1,
      id: "e1",
      at: 0,
      threadId: "t",
      payload: { type: "thread.updated", title: "Changed title" },
    });
    outbox.send({
      type: "events",
      subscriptionId: "s",
      afterSeq: 0,
      throughSeq: 1,
      events: [event],
    });
    outbox.send({
      type: "pluginResult",
      requestId: "list",
      response: { type: "plugins.list", installs: [], reviews: [] },
    });
    outbox.send({ type: "pong" });
    await delivered.promise;
    expect(received).toEqual([
      { type: "events", subscriptionId: "s", afterSeq: 0, throughSeq: 1, events: [event] },
      {
        type: "pluginResult",
        requestId: "list",
        response: { type: "plugins.list", installs: [], reviews: [] },
      },
      { type: "pong" },
    ]);
  } finally {
    const closed = once(client, "close");
    client.terminate();
    await closed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("queues metadata with linear payload reads and delivers every event in order", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new Client(`ws://127.0.0.1:${address.port}`);
  const opened = once(client.socket, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
  await opened;
  const outbox = new Outbox(socket, { ...defaultPressure, softLimit: -1 });
  try {
    let reads = 0;
    for (let seq = 1; seq <= 400; seq++) {
      const event = Event.parse({
        seq,
        id: `e${seq}`,
        at: 1,
        threadId: "t",
        payload: { type: "thread.updated", title: `Title ${seq}` },
      });
      const payload = event.payload;
      Object.defineProperty(event, "payload", {
        enumerable: true,
        get() {
          reads++;
          return payload;
        },
      });
      outbox.send({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [event],
      });
    }
    expect(reads).toBeLessThan(400 * 10);
    for (const [seq, append] of [
      [401, "A"],
      [402, "B"],
    ] as const) {
      const event = Event.parse({
        seq,
        id: `e${seq}`,
        at: 1,
        threadId: "t",
        payload: { type: "item.delta", itemId: "i", agentId: "a", field: "text", append },
      });
      outbox.send({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [event],
      });
    }
    outbox.send({ type: "pong" });
    const received = ServerMessage.parse(await client.next());
    if (received.type !== "events") throw new Error("Missing queued events");
    expect(received).toMatchObject({ afterSeq: 0, throughSeq: 402 });
    expect(received.events.map((e) => e.seq)).toEqual([
      ...Array.from({ length: 400 }, (_, i) => i + 1),
      402,
    ]);
    expect(received.events.at(-1)).toMatchObject({
      firstSeq: 401,
      seq: 402,
      payload: { append: "AB" },
    });
    expect(await client.next()).toEqual({ type: "pong" });
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("terminates a socket after a transport send callback fails", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new Client(`ws://127.0.0.1:${address.port}`);
  const opened = once(client.socket, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing server socket");
  await opened;
  const outbox = new Outbox(socket, defaultPressure);
  try {
    const closed = once(client.socket, "close").then(([code]) => code);
    const send = vi
      .spyOn(socket, "send")
      .mockImplementation((_data, optionsOrCallback, callback) => {
        const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
        done?.(new Error("Injected transport failure"));
      });
    outbox.send({ type: "pong" });
    send.mockRestore();
    outbox.send({ type: "pong" });
    expect(
      await Promise.race([
        closed,
        client.next().then(
          () => "delivered",
          () => closed,
        ),
      ]),
    ).toBe(1006);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("a congested delta burst keeps every append and contiguous coverage below the frame budget", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new Client(`ws://127.0.0.1:${address.port}`);
  const opened = once(client.socket, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing socket");
  await opened;
  try {
    const outbox = new Outbox(socket, { ...defaultPressure, softLimit: -1 });
    for (let seq = 1; seq <= 600; seq++)
      outbox.send({
        type: "events",
        subscriptionId: "s",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [
          Event.parse({
            seq,
            id: `e${seq}`,
            at: 1,
            threadId: "t",
            payload: {
              type: "item.delta",
              itemId: "i",
              agentId: "a",
              field: "text",
              append: "x".repeat(4096),
            },
          }),
        ],
      });
    outbox.send({ type: "pong" });
    let cursor = 0;
    let bytes = 0;
    for (;;) {
      const message = ServerMessage.parse(await client.next());
      if (message.type === "pong") break;
      if (message.type !== "events") throw new Error("Expected appends");
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1024 * 1024);
      expect(message.afterSeq).toBe(cursor);
      cursor = message.throughSeq;
      for (const event of message.events)
        if (event.payload.type === "item.delta") bytes += event.payload.append.length;
    }
    expect(cursor).toBe(600);
    expect(bytes).toBe(600 * 4096);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("releasing and replacing large subscriptions cannot retain unlimited snapshot sources", async () => {
  const { Store, createDevThread } = await import("./index.ts");
  const { Interaction } = await import("@ace/protocol");
  const store = new Store(":memory:");
  const thread = createDevThread(store, store.createWorkspace("/synthetic", "Synthetic"));
  const view = store.snapshotThread(thread.id);
  view.interactions.large = Interaction.parse({
    id: "large",
    threadId: thread.id,
    agentId: "root",
    state: "pending",
    blocking: true,
    createdAt: 1,
    request: { kind: "approval", title: "x".repeat(2 * 1024 * 1024), options: [] },
  });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const connected = once(server, "connection");
  const client = new Client(`ws://127.0.0.1:${address.port}`);
  const opened = once(client.socket, "open");
  const [socket] = await connected;
  if (!(socket instanceof WebSocket)) throw new Error("Missing socket");
  await opened;
  try {
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get: () => defaultPressure.softLimit + 1,
    });
    const closed = once(client.socket, "close").then(([code]) => code);
    const outbox = new Outbox(socket, defaultPressure);
    for (let index = 0; index < 5; index++)
      outbox.send({ type: "snapshot", subscriptionId: `s${index}`, seq: view.seq, view });
    expect(await closed).toBe(4009);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  }
});
