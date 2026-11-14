import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { AgentId, Item, ServerMessage, ThreadId, type ClientMessage } from "@ace/protocol";
import { expandShortDeltas, shortDeltasFraming } from "@ace/projection/short-deltas";
import { wireTrims } from "@ace/projection/wire-trim";
import { visibleHistoryOrder } from "@ace/projection";
import { FakeDaemon, seedColdStartState } from "@ace/fake-daemon";
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
  trimmed.send({
    type: "item.raw",
    requestId: "r",
    threadId: f.thread.id,
    itemId: reply.id,
    from: 0,
  });
  const answer = ServerMessage.parse(
    JSON.parse(await trimmed.until((text) => text.includes('"requestId":"r"'))),
  );
  expect(answer).toEqual({
    type: "item.raw",
    requestId: "r",
    threadId: f.thread.id,
    itemId: reply.id,
    from: 0,
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
    from: 0,
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

/** The `cold-legacy` thread of the fake daemon's cold-start fixture, as stored items. */
function coldLegacyItems(): Item[] {
  const fake = new FakeDaemon({ clock: () => 1000 });
  seedColdStartState(fake);
  const view = fake.snapshot({ kind: "thread", threadId: ThreadId.parse("cold-legacy") });
  if (!view || view.kind !== "thread") throw new Error("Missing cold-legacy");
  return view.itemOrder.flatMap((id) => view.items[id] ?? []);
}

/** What a transcript shows: its visible items in order, each by id and text. */
function visible(items: readonly Item[]): string[] {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  return visibleHistoryOrder(
    items.map((item) => item.id),
    (id) => byId.get(id),
  ).map((id) => {
    const item = byId.get(id);
    const text =
      item?.type === "message"
        ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        : item?.type === "notice"
          ? item.text
          : (item?.type ?? "");
    return `${id}: ${text}`;
  });
}

const itemsOf = (message: ServerMessage): Item[] => {
  if (message.type === "snapshot" && message.view.kind === "thread") {
    const { view } = message;
    return view.itemOrder.flatMap((id) => view.items[id] ?? []);
  }
  if (message.type === "items.page") return message.items;
  if (message.type === "events")
    return message.events.flatMap((event) =>
      event.payload.type === "item.created" ? [event.payload.item] : [],
    );
  return [];
};

test("a trimmed client shows the same transcript as a whole one: snapshot, replay and history page", async () => {
  const { f, join } = await setup();
  const stored = coldLegacyItems();
  const whole = await join({});
  const trimmed = await join({
    trims: [wireTrims.rawOnDemand],
    framing: ["lines", shortDeltasFraming],
  });
  const before = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    stored.map((item) => ({ type: "item.created" as const, item })),
  );
  const transcript = async (client: Awaited<ReturnType<typeof join>>, tag: string) => {
    // Live: the events each subscribed client was sent as the items were stored.
    const live = itemsOf(parsed(await client.until(isEvents)));
    // Replay: a new subscription resuming from before the items.
    client.send({
      type: "subscribe",
      subscriptionId: `replay-${tag}`,
      scope: { kind: "thread", threadId: f.thread.id },
      afterSeq: before,
    });
    const replay = itemsOf(parsed(await client.until((text) => text.includes(`"replay-${tag}"`))));
    // Snapshot: a new subscription from scratch.
    client.send({
      type: "subscribe",
      subscriptionId: `fresh-${tag}`,
      scope: { kind: "thread", threadId: f.thread.id },
    });
    const snapshot = itemsOf(
      parsed(
        await client.until(
          (text) => text.includes(`"fresh-${tag}"`) && text.includes('"snapshot"'),
        ),
      ),
    );
    // History page: the newest items, as scrolling back reads them.
    client.send({
      type: "items.page",
      requestId: `page-${tag}`,
      threadId: f.thread.id,
      before: Number.MAX_SAFE_INTEGER,
      limit: 200,
    });
    const page = itemsOf(parsed(await client.until((text) => text.includes(`"page-${tag}"`))));
    return { live, replay, snapshot, page };
  };
  const expected = visible(stored);
  // The fixture's point: the system message is hidden and the replayed answer shown once.
  expect(expected.some((line) => line.includes("Internal tool schemas"))).toBe(false);
  expect(expected.filter((line) => line.includes("I checked the reconnect path."))).toHaveLength(1);
  const wholeSeen = await transcript(whole, "whole");
  const trimmedSeen = await transcript(trimmed, "trimmed");
  for (const path of ["live", "replay", "snapshot", "page"] as const) {
    expect(visible(wholeSeen[path]), `whole ${path}`).toEqual(expected);
    expect(visible(trimmedSeen[path]), `trimmed ${path}`).toEqual(expected);
  }
});

test("raw payloads beyond one reply are read page by page, every one exactly once", async () => {
  const { f, join } = await setup();
  const client = await join({ trims: [wireTrims.rawOnDemand] });
  // 40 entries of about 60 KB: each stays inline, together well over one 1 MiB reply.
  const many = Array.from({ length: 40 }, (_, index) => ({
    type: "assistant",
    data: { index, text: String(index % 10).repeat(60_000) },
  }));
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: Item.parse({ ...reply, raw: many }) },
  ]);
  const read: unknown[] = [];
  let from: number | undefined = 0;
  let pages = 0;
  while (from !== undefined) {
    client.send({
      type: "item.raw",
      requestId: `p${pages}`,
      threadId: f.thread.id,
      itemId: reply.id,
      from,
    });
    const answer = ServerMessage.parse(
      JSON.parse(await client.until((text) => text.includes(`"requestId":"p${pages}"`))),
    );
    if (answer.type !== "item.raw") throw new Error(`Unexpected ${answer.type}`);
    expect(answer.from).toBe(from);
    expect(answer.raw.length).toBeGreaterThan(0);
    read.push(...answer.raw);
    from = answer.next;
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(read).toEqual(many);
});

test("a client that reconnects asking for another trim gets that encoding, not the one cached", async () => {
  const { f, join } = await setup();
  const before = f.store.headSeq();
  const first = await join({});
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: reply }]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: reply.id,
      agentId: AgentId.parse("root"),
      field: "text",
      append: "!",
    },
  ]);
  // The whole encodings of both events are cached now, from the first client.
  expect(await first.until(isEvents)).toContain(JSON.stringify(raw));
  expect(await first.until(isEvents)).toContain('"payload":{"type":"item.delta"');
  await first.close();
  const again = await join({
    trims: [wireTrims.rawOnDemand],
    framing: ["lines", shortDeltasFraming],
  });
  again.send({
    type: "subscribe",
    subscriptionId: "resume",
    scope: { kind: "thread", threadId: f.thread.id },
    afterSeq: before,
  });
  const resumed = await again.until((text) => text.includes('"resume"'));
  expect(resumed).not.toContain(JSON.stringify(raw));
  const events = parsed(resumed);
  if (events.type !== "events") throw new Error(`Replay came as ${events.type}`);
  expect(events.events.map((event) => event.payload)).toMatchObject([
    { type: "item.created", item: { raw: [], rawOmitted: true } },
    { type: "item.delta", append: "!" },
  ]);
  expect(resumed).toContain('"d":[');
  // And back: a whole client after the trimmed one gets the stored bytes.
  const whole = await join({});
  whole.send({
    type: "subscribe",
    subscriptionId: "resume-whole",
    scope: { kind: "thread", threadId: f.thread.id },
    afterSeq: before,
  });
  const wholeText = await whole.until((text) => text.includes('"resume-whole"'));
  expect(wholeText).toContain(JSON.stringify(raw));
  expect(wholeText).not.toContain('"d":[');
});
