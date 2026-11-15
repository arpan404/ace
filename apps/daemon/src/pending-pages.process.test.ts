import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  Interaction,
  InteractionId,
  ServerMessage,
  type ClientMessage,
  type ThreadId,
} from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import type { Store } from "./store.ts";

// Pending requests come first in a thread's interaction pages, but still paged by bytes: however
// many and however large, a reader finds every one by reading on, each whole. A page holds what
// was asked, or one request larger than that alone; one too large for any reply is named in its
// place. A real socket, because the bounds and failures are about the frames that go out.

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

test("a hundred pending requests of 400 KiB each are all found whole, one to a page", async () => {
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
  while (before !== null) {
    const { text, page: result } = await page(before, 64 * 1024);
    // Larger than the 64 KiB asked for, so alone; the envelope around it is small.
    expect(result.entries).toHaveLength(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400 * 1024 + 2048);
    for (const entry of result.entries) found.set(entry.id, entry);
    before = result.entitiesBefore;
  }
  expect([...found.values()].filter((entry) => entry.state === "pending")).toHaveLength(100);
  const one = found.get("ask-7");
  expect(one?.request.kind === "approval" && one.request.description).toBe("d".repeat(400 * 1024));
});

test("a request too large for any reply is named in its place, and paging goes on", async () => {
  const { f, page } = await setup();
  f.store.appendEvents(f.thread.id, [
    { type: "interaction.opened", interaction: approval(f.thread.id, "small-1", "Deploy?") },
    {
      type: "interaction.opened",
      interaction: approval(f.thread.id, "huge", "h".repeat(33 * 1024 * 1024)),
    },
    { type: "interaction.opened", interaction: approval(f.thread.id, "small-2", "Ship?") },
  ]);
  const ids: string[] = [];
  const tooLarge: unknown[] = [];
  let before: number | null = Number.MAX_SAFE_INTEGER;
  while (before !== null) {
    const { page: result } = await page(before);
    ids.push(...result.entries.map((entry) => entry.id));
    tooLarge.push(...(result.tooLarge ?? []));
    before = result.entitiesBefore;
  }
  expect(ids.toSorted()).toEqual(["small-1", "small-2"]);
  expect(tooLarge).toEqual([
    { id: "huge", kind: "approval", active: true, bytes: expect.any(Number) },
  ]);
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
