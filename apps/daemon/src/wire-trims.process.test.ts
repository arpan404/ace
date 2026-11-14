import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { AgentId, Item, ServerMessage, ThreadId, type ClientMessage } from "@ace/protocol";
import { expandShortDeltas, shortDeltasFraming } from "@ace/projection/short-deltas";
import { wireTrims } from "@ace/projection/wire-trim";
import { fixture, token } from "./socket-test-support.ts";

// A real daemon socket, read as text: what each client's hello asked for is what its frames
// carry, while every client of the thread is fed from one stream of events.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A socket that keeps every message's text as it came, frames unpacked. */
async function rawClient(url: string) {
  const socket = new WebSocket(url);
  const texts: string[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    for (const line of data.toString().split("\n")) texts.push(line);
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "open");
  let read = 0;
  return {
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    /** The next message's text that `match` accepts, skipping the others. */
    async until(match: (text: string) => boolean): Promise<string> {
      for (;;) {
        while (read < texts.length) {
          const text = texts[read++] ?? "";
          if (match(text)) return text;
        }
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
    close: async () => {
      socket.close();
      if (socket.readyState !== WebSocket.CLOSED) await once(socket, "close");
    },
  };
}

const raw = [{ type: "assistant", data: { image: "iVBORw0KGgo".repeat(40) } }];
const reply = Item.parse({
  id: "reply",
  agentId: "root",
  type: "message",
  role: "assistant",
  parts: [{ type: "text", text: "Hi" }],
  createdAt: 1,
  complete: false,
  raw,
});

async function setup(canReadThread?: (device: string, thread: ThreadId) => boolean) {
  const f = await fixture(canReadThread ? { canReadThread } : {});
  cleanups.push(() => f.close());
  const join = async (hello: Partial<Extract<ClientMessage, { type: "hello" }>>) => {
    const client = await rawClient(f.server.url);
    cleanups.push(() => client.close());
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: "device",
      token,
      ...hello,
    } as ClientMessage);
    await client.until((text) => text.includes('"type":"welcome"'));
    client.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    await client.until((text) => text.includes('"type":"snapshot"'));
    return client;
  };
  return { f, join };
}

const isEvents = (text: string) => text.startsWith('{"type":"events"');
const parsed = (text: string) => ServerMessage.parse(expandShortDeltas(JSON.parse(text)));

test("trimmed and whole clients of one thread each get their own encoding of the same events", async () => {
  const { f, join } = await setup();
  const whole = await join({});
  const trimmed = await join({
    trims: [wireTrims.rawOnDemand],
    framing: ["lines", shortDeltasFraming],
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: reply }]);
  const [delta] = f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: reply.id,
      agentId: AgentId.parse("root"),
      field: "text",
      append: " there",
    },
  ]);
  if (!delta) throw new Error("no delta stored");

  // The client that asked for nothing new gets the stored events byte for byte.
  const wholeCreated = await whole.until(isEvents);
  expect(wholeCreated).toContain(JSON.stringify(raw));
  expect(await whole.until(isEvents)).toContain(JSON.stringify(delta));

  const trimmedCreated = parsed(await trimmed.until(isEvents));
  const shortText = await trimmed.until(isEvents);
  expect(shortText).not.toContain(delta.id);
  const trimmedDelta = parsed(shortText);
  if (trimmedCreated.type !== "events" || trimmedDelta.type !== "events") throw new Error("shape");
  expect(trimmedCreated.events[0]?.payload).toMatchObject({
    type: "item.created",
    item: { id: "reply", raw: [], rawOmitted: true },
  });
  // The short delta rebuilds the same event: thread, order, time and text (its id aside).
  const { id: _stored, ...sent } = delta;
  const { id: _rebuilt, ...rebuilt } = trimmedDelta.events[0] ?? delta;
  expect(rebuilt).toEqual(sent);

  // The raw payloads it went without are one read away, under the item's own access.
  trimmed.send({ type: "item.raw", requestId: "r", threadId: f.thread.id, itemId: reply.id });
  const answer = ServerMessage.parse(
    JSON.parse(await trimmed.until((text) => text.includes('"requestId":"r"'))),
  );
  expect(answer).toEqual({
    type: "item.raw",
    requestId: "r",
    threadId: f.thread.id,
    itemId: reply.id,
    raw,
  });
});

test("an item's raw payloads are refused where the thread is not readable, and absent items say so", async () => {
  const { f, join } = await setup((_device, thread) => thread !== ThreadId.parse("hidden"));
  const client = await join({ trims: [wireTrims.rawOnDemand] });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: reply }]);
  client.send({
    type: "item.raw",
    requestId: "hidden",
    threadId: ThreadId.parse("hidden"),
    itemId: reply.id,
  });
  expect(
    JSON.parse(await client.until((text) => text.includes('"requestId":"hidden"'))),
  ).toMatchObject({
    type: "error",
    code: "forbidden",
  });
  client.send({
    type: "item.raw",
    requestId: "missing",
    threadId: f.thread.id,
    itemId: "nope",
  } as ClientMessage);
  expect(
    JSON.parse(await client.until((text) => text.includes('"requestId":"missing"'))),
  ).toMatchObject({
    type: "error",
    code: "item_not_found",
  });
});
