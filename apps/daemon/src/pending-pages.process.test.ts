import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  CommandId,
  DeviceId,
  Interaction,
  InteractionId,
  ServerMessage,
  type ClientMessage,
  type ThreadId,
} from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import type { Store } from "./store.ts";

// Pending requests come first in a thread's interaction pages, but still paged by bytes: however
// many and however large, a reader finds every one by reading on. A page holds what was asked,
// or one request larger than that alone; one too large to send with its thread goes summarized
// and says so (ADR 0156), in pages, snapshots and live events alike, and reads back whole with
// `interaction.read`. A real socket, because the bounds and failures are about the frames that go
// out (#2099: an oversized snapshot resynced the connection in a loop).

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const approval = (threadId: string, id: string, description: string) =>
  Interaction.parse({
    id,
    threadId,
    agentId: "root",
    blocking: true,
    request: {
      kind: "approval",
      title: `Run ${id}`,
      description,
      target: { tool: "Bash", command: `make ${id}`, access: "execute" },
      options: [
        { id: `${id}:allow`, label: "Allow once", kind: "allow_once" },
        { id: `${id}:deny`, label: "Deny", kind: "deny" },
      ],
    },
    state: "pending",
    createdAt: 1,
  });
const resolve = (store: Store, threadId: ThreadId, id: string) =>
  store.appendEvents(threadId, [
    {
      type: "interaction.closed",
      interactionId: InteractionId.parse(id),
      state: "resolved",
      resolution: { kind: "approval", optionId: `${id}:allow` },
      closedAt: 2,
    },
  ]);

/** A socket that keeps each message's text, and says when it closed. */
async function connect(url: string) {
  const socket = new WebSocket(url);
  const texts: string[] = [];
  const waiters: (() => void)[] = [];
  let closed: number | undefined;
  socket.on("message", (data) => {
    texts.push(data.toString());
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("close", (code) => {
    closed = code;
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "open");
  cleanups.push(async () => {
    socket.close();
    if (socket.readyState !== WebSocket.CLOSED) await once(socket, "close");
  });
  let read = 0;
  const until = async (match: (text: string) => boolean) => {
    for (;;) {
      while (read < texts.length) {
        const text = texts[read++] ?? "";
        if (match(text)) return text;
      }
      if (closed !== undefined) throw new Error(`Socket closed with ${closed}`);
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: "phone",
      token,
    } as ClientMessage),
  );
  await until((text) => text.includes('"type":"welcome"'));
  return { send: (message: ClientMessage) => socket.send(JSON.stringify(message)), until };
}

async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  const client = await connect(f.server.url);
  let request = 0;
  /** One newest-first page of interactions from `before`; its reply's text and its page. */
  const page = async (before: number, maxBytes?: number) => {
    const requestId = `r${++request}`;
    client.send({
      type: "entities.page",
      requestId,
      threadId: f.thread.id,
      collection: "interactions",
      before,
      limit: 50,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    const text = await client.until((sent) => sent.includes(`"requestId":"${requestId}"`));
    const reply = ServerMessage.parse(JSON.parse(text));
    if (reply.type !== "entities.page") throw new Error(`Unexpected ${text.slice(0, 200)}`);
    if (reply.page.collection !== "interactions") throw new Error("Wrong collection");
    return { text, page: reply.page };
  };
  return { f, client, page };
}

test("a hundred pending requests of 400 KiB each are all found, each summarized and saying so", async () => {
  const { f, page } = await setup();
  for (let index = 0; index < 100; index++)
    f.store.appendEvents(f.thread.id, [
      {
        type: "interaction.opened",
        interaction: approval(f.thread.id, `ask-${index}`, "d".repeat(400 * 1024)),
      },
    ]);
  const found = new Map<string, Interaction>();
  let before: number | null = Number.MAX_SAFE_INTEGER;
  let pages = 0;
  while (before !== null) {
    const { page: result } = await page(before, 64 * 1024);
    pages++;
    for (const entry of result.entries) found.set(entry.id, entry);
    before = result.entitiesBefore;
  }
  const pending = [...found.values()].filter((entry) => entry.state === "pending");
  expect(pending).toHaveLength(100);
  expect(pending.every((entry) => (entry.truncated?.chars ?? 0) > 400 * 1024)).toBe(true);
  // Summaries are small: many to a page, never one request to a page.
  expect(pages).toBeLessThan(20);
});

test("a request too large for any reply goes summarized in its place, and paging goes on", async () => {
  const { f, page } = await setup();
  f.store.appendEvents(f.thread.id, [
    { type: "interaction.opened", interaction: approval(f.thread.id, "small-1", "Deploy?") },
    {
      type: "interaction.opened",
      interaction: approval(f.thread.id, "huge", "h".repeat(33 * 1024 * 1024)),
    },
    { type: "interaction.opened", interaction: approval(f.thread.id, "small-2", "Ship?") },
  ]);
  const found = new Map<string, Interaction>();
  let before: number | null = Number.MAX_SAFE_INTEGER;
  while (before !== null) {
    const { page: result } = await page(before);
    for (const entry of result.entries) found.set(entry.id, entry);
    expect(result.tooLarge).toBeUndefined();
    before = result.entitiesBefore;
  }
  expect([...found.keys()].toSorted()).toEqual(["huge", "small-1", "small-2"]);
  expect(found.get("huge")?.truncated?.chars).toBeGreaterThan(33 * 1024 * 1024);
  expect(found.get("small-1")?.truncated).toBeUndefined();
});

test("a request answered between page reads never makes the rest of the pending ones vanish", async () => {
  const { f, page } = await setup();
  // 201 older pending requests, then recent answered ones in front of them.
  for (let index = 0; index < 201; index++)
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, `ask-${index}`, "Deploy?") },
    ]);
  for (let index = 0; index < 30; index++) {
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, `done-${index}`, "Done") },
    ]);
    resolve(f.store, f.thread.id, `done-${index}`);
  }
  const found = new Map<string, Interaction>();
  const first = await page(Number.MAX_SAFE_INTEGER);
  for (const entry of first.page.entries) found.set(entry.id, entry);
  // One the first page did not carry is answered before the next read.
  const unread = Array.from({ length: 201 }, (_, i) => `ask-${i}`).find((id) => !found.has(id));
  if (!unread) throw new Error("The first page carried every request");
  resolve(f.store, f.thread.id, unread);
  let before = first.page.entitiesBefore;
  while (before !== null) {
    const next = await page(before);
    for (const entry of next.page.entries) found.set(entry.id, entry);
    before = next.page.entitiesBefore;
  }
  const pending = [...found.values()].filter((entry) => entry.state === "pending");
  expect(pending).toHaveLength(200);
});

test("a cursor an older daemon gave, resumed after the upgrade, reads from the start and finds every pending request", async () => {
  const { f, page } = await setup();
  // Ten pending requests, then sixty answered ones in front of them.
  for (let index = 0; index < 10; index++)
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, `ask-${index}`, "Deploy?") },
    ]);
  const opened: number[] = [];
  for (let index = 0; index < 60; index++) {
    const [event] = f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, `done-${index}`, "Done") },
    ]);
    opened.push(event?.seq ?? 0);
    resolve(f.store, f.thread.id, `done-${index}`);
  }
  // An older daemon's first page held the newest 50, all answered; its cursor was the bare
  // creation sequence of the oldest of them, with every pending request below it.
  const older = opened[10] ?? 0;
  const found = new Map<string, Interaction>();
  let before: number | null = older;
  while (before !== null) {
    const next = await page(before);
    for (const entry of next.page.entries) found.set(entry.id, entry);
    before = next.page.entitiesBefore;
  }
  expect([...found.values()].filter((entry) => entry.state === "pending")).toHaveLength(10);
  expect(found.size).toBe(70);
});

/** Subscribe to the thread; its snapshot's interactions, from the one whole snapshot frame. */
async function openThread(client: Awaited<ReturnType<typeof connect>>, threadId: ThreadId) {
  client.send({ type: "subscribe", subscriptionId: "thread", scope: { kind: "thread", threadId } });
  const text = await client.until(
    (sent) => sent.includes('"subscriptionId":"thread"') && sent.includes('"type":"snapshot'),
  );
  const message = ServerMessage.parse(JSON.parse(text));
  if (message.type !== "snapshot" || message.view.kind !== "thread")
    throw new Error(`Expected one snapshot frame, got ${text.slice(0, 120)}`);
  return message.view.interactions;
}

test("a thread with a hundred pending requests of 400 KiB each opens, each request summarized", async () => {
  const { f, client } = await setup();
  for (let index = 0; index < 100; index++)
    f.store.appendEvents(f.thread.id, [
      {
        type: "interaction.opened",
        interaction: approval(f.thread.id, `ask-${index}`, "d".repeat(400 * 1024)),
      },
    ]);
  const interactions = Object.values(await openThread(client, f.thread.id));
  expect(interactions.filter((entry) => entry.state === "pending")).toHaveLength(100);
  expect(interactions.every((entry) => entry.truncated !== undefined)).toBe(true);
});

test("a thread with one pending request of 33 Mi characters opens, the request summarized", async () => {
  const { f, client } = await setup();
  f.store.appendEvents(f.thread.id, [
    {
      type: "interaction.opened",
      interaction: approval(f.thread.id, "huge", "h".repeat(33 * 1024 * 1024)),
    },
  ]);
  const huge = (await openThread(client, f.thread.id))["huge"];
  expect(huge?.state).toBe("pending");
  expect(huge?.truncated?.chars).toBeGreaterThan(33 * 1024 * 1024);
  // Every option an answer names is still there to decline with.
  expect(huge?.request.kind === "approval" && huge.request.options.map((o) => o.id)).toEqual([
    "huge:allow",
    "huge:deny",
  ]);
});

test("a large request opened while the thread is open arrives summarized, and the connection stays", async () => {
  const { f, client } = await setup();
  await openThread(client, f.thread.id);
  f.store.appendEvents(f.thread.id, [
    {
      type: "interaction.opened",
      interaction: approval(f.thread.id, "live", "l".repeat(2 * 1024 * 1024)),
    },
  ]);
  const text = await client.until(
    (sent) => sent.includes('"type":"events"') && sent.includes('"interaction.opened"'),
  );
  const message = ServerMessage.parse(JSON.parse(text));
  if (message.type !== "events") throw new Error("Expected events");
  const opened = message.events.find((event) => event.payload.type === "interaction.opened");
  expect(
    opened?.payload.type === "interaction.opened" && opened.payload.interaction.truncated,
  ).toEqual({ chars: expect.any(Number) });
  expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
});

/** Read `id`'s whole request from the daemon, page by page; its pages' versions too. */
async function readWhole(
  client: Awaited<ReturnType<typeof connect>>,
  threadId: ThreadId,
  id: string,
  between?: () => void,
) {
  let offset = 0;
  let text = "";
  const versions = new Set<string>();
  for (let read = 0; ; read++) {
    const requestId = `read-${id}-${read}`;
    client.send({
      type: "interaction.read",
      requestId,
      threadId,
      interactionId: InteractionId.parse(id),
      offset,
    });
    const sent = await client.until((reply) => reply.includes(`"requestId":"${requestId}"`));
    const reply = ServerMessage.parse(JSON.parse(sent));
    if (reply.type !== "interaction.data") return { error: sent, text, versions };
    expect(Buffer.byteLength(sent)).toBeLessThan(256 * 1024);
    versions.add(reply.version);
    text += reply.text;
    offset = reply.nextOffset;
    if (reply.eof) return { text, versions, total: reply.total };
    if (read === 0) between?.();
  }
}

test("a summarized request reads back whole, page by page, exactly as it was asked", async () => {
  const { f, client } = await setup();
  // Characters of two code units throughout, so a page boundary falls inside one if it can.
  const asked = approval(f.thread.id, "big", `start ${"😀é".repeat(300 * 1024)} end`);
  f.store.appendEvents(f.thread.id, [{ type: "interaction.opened", interaction: asked }]);
  const read = await readWhole(client, f.thread.id, "big");
  expect(read.versions.size).toBe(1);
  expect(read.text.length).toBe(read.total);
  expect(JSON.parse(read.text)).toEqual(asked.request);
});

test("a request replaced while it is being read reads under a new version", async () => {
  const { f, client } = await setup();
  f.store.appendEvents(f.thread.id, [
    {
      type: "interaction.opened",
      interaction: approval(f.thread.id, "big", "a".repeat(400 * 1024)),
    },
  ]);
  const read = await readWhole(client, f.thread.id, "big", () =>
    f.store.appendEvents(f.thread.id, [
      {
        type: "interaction.opened",
        interaction: approval(f.thread.id, "big", "b".repeat(400 * 1024)),
      },
    ]),
  );
  expect(read.versions.size).toBe(2);
});

test("reading a request of a thread that holds no such request is refused", async () => {
  const { f, client } = await setup();
  const read = await readWhole(client, f.thread.id, "missing");
  expect(read.error).toContain('"type":"error"');
});

test("an affirmative answer to a summarized request goes only once the request as it is was shown whole", async () => {
  const { f, client } = await setup();
  const open = (id: string, description: string) =>
    f.store.appendEvents(f.thread.id, [
      { type: "interaction.opened", interaction: approval(f.thread.id, id, description) },
    ]);
  for (const id of ["first", "second", "replaced"]) open(id, "d".repeat(400 * 1024));
  let count = 0;
  const answer = async (id: string, option: "allow" | "deny", shown?: string) => {
    const commandId = CommandId.parse(`answer-${++count}`);
    client.send({
      type: "command",
      command: {
        id: commandId,
        deviceId: DeviceId.parse("phone"),
        payload: {
          type: "interaction.resolve",
          interactionId: InteractionId.parse(id),
          resolution: { kind: "approval", optionId: `${id}:${option}` },
          ...(shown === undefined ? {} : { readWhole: shown }),
        },
      },
    });
    return client.until((sent) => sent.includes(`"commandId":"${commandId}"`));
  };
  const version = async (id: string) => {
    const [only] = (await readWhole(client, f.thread.id, id)).versions;
    return only ?? "";
  };
  expect(await answer("first", "allow")).toContain("request_not_read");
  expect(await answer("first", "allow", "not-a-version")).toContain("request_not_read");
  expect(f.store.getInteraction("first")?.state).toBe("pending");
  expect(await answer("first", "allow", await version("first"))).toContain('"ok":true');
  expect(await answer("second", "deny")).toContain('"ok":true');
  // Read whole, then replaced by another request before the answer: what was shown is gone.
  const shown = await version("replaced");
  open("replaced", "e".repeat(400 * 1024));
  expect(await answer("replaced", "allow", shown)).toContain("request_not_read");
  expect(f.store.getInteraction("first")?.state).toBe("resolved");
  expect(f.store.getInteraction("second")?.state).toBe("resolved");
  expect(f.store.getInteraction("replaced")?.state).toBe("pending");
});
