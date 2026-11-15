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
// many and however large, a reader finds every one by reading on, each page within its bound,
// and a request too large for a page alone comes cut, still showable and answerable. A real
// socket, because the bounds and failures are about the frames that go out.

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

test("a hundred pending requests of 400 KiB each are all found, each page within its bound", async () => {
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
    // The page's entries within what was asked; the envelope around them is small.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024 + 1024);
    for (const entry of result.entries) found.set(entry.id, entry);
    expect(result.entitiesBefore).not.toBe(before);
    before = result.entitiesBefore;
  }
  expect([...found.values()].filter((entry) => entry.state === "pending")).toHaveLength(100);
  // Cut, never dropped: what the phone shows and answers with is whole; the rest says its size.
  const one = found.get("ask-7");
  expect(one?.request).toMatchObject({
    kind: "approval",
    title: "Run ask-7",
    target: { command: "make ask-7" },
    options: [{ id: "ask-7:allow" }, { id: "ask-7:deny" }],
  });
  expect(one?.request.kind === "approval" && one.request.description).toMatch(
    new RegExp(`\\[cut: ${400 * 1024} bytes\\]$`),
  );
});

/** Subscribe `client` to the thread and wait for its snapshot, whole or in parts. */
async function open(client: Awaited<ReturnType<typeof connect>>, threadId: ThreadId, id: string) {
  client.send({ type: "subscribe", subscriptionId: id, scope: { kind: "thread", threadId } });
  const parts: string[] = [];
  for (;;) {
    const text = await client.until((sent) => sent.includes(`"subscriptionId":"${id}"`));
    const message = JSON.parse(text) as { type: string; data?: string; done?: boolean };
    if (message.type === "snapshot") {
      parts.push(text);
      break;
    }
    if (message.type === "snapshot.part") {
      parts.push(message.data ?? "");
      if (message.done) break;
    }
  }
  const whole = parts.length === 1 && parts[0]?.startsWith("{") ? parts[0] : parts.join("");
  const snapshot = ServerMessage.parse(JSON.parse(whole));
  if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread") throw new Error("shape");
  return snapshot.view;
}

const hundredLarge = (store: Store, threadId: ThreadId) => {
  for (let index = 0; index < 100; index++)
    store.appendEvents(threadId, [
      {
        type: "interaction.opened",
        interaction: approval(threadId, `ask-${index}`, "d".repeat(400 * 1024)),
      },
    ]);
};

test("a thread with a hundred pending requests of 400 KiB each still opens", async () => {
  const { f, client } = await setup();
  hundredLarge(f.store, f.thread.id);
  // Whole, or in parts; never a socket closed for it.
  const view = await open(client, f.thread.id, "open");
  expect(
    Object.values(view.interactions).filter((entry) => entry.state === "pending"),
  ).toHaveLength(100);
});

test("a thread already open when a hundred 400 KiB requests arrive still opens for the next reader", async () => {
  const { f, client } = await setup();
  await open(client, f.thread.id, "first");
  hundredLarge(f.store, f.thread.id);
  const next = await connect(f.server.url);
  const view = await open(next, f.thread.id, "second");
  const pending = Object.values(view.interactions).filter((entry) => entry.state === "pending");
  expect(pending).toHaveLength(100);
  expect(pending[0]?.request).toMatchObject({
    kind: "approval",
    target: { command: expect.stringMatching(/^make ask-/) },
  });
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
