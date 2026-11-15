import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { AgentId, Item, ItemId, ServerMessage, type ClientMessage } from "@ace/protocol";
import { wireTrims } from "@ace/projection/wire-trim";
import { pageReplyBytes } from "./reply-bounds.ts";
import { entryBytes } from "./services/item-raw.ts";
import { fixture, token } from "./socket-test-support.ts";
import type { Store } from "./store.ts";

// The paged reads a client can ask for on the main channel, each given the largest data it can
// hold: every reply stays within the bound (`reply-bounds.ts`), and reading on from each reply
// gives back exactly what is stored, so a bound never cuts what a reader gets. A real socket,
// because the bound is about the frames that go out.

/** What a reply may add around its payload: type, ids, offsets and cursors. */
const envelopeBytes = 1024;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function connect(url: string) {
  const socket = new WebSocket(url);
  const texts: string[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    texts.push(data.toString());
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
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  send({
    type: "hello",
    protocolVersion: 1,
    deviceId: "device",
    token,
    trims: [wireTrims.rawOnDemand],
  } as ClientMessage);
  await until((text) => text.includes('"type":"welcome"'));
  let request = 0;
  /** Send `message` with a fresh request id and return its reply's text. */
  return async (message: Record<string, unknown>) => {
    const requestId = `r${++request}`;
    send({ ...message, requestId } as ClientMessage);
    return until((text) => text.includes(`"requestId":"${requestId}"`));
  };
}

const root = AgentId.parse("root");
const words = (bytes: number) =>
  "the build printed a long log line with numbers 0123456789 and more\n"
    .repeat(Math.ceil(bytes / 66))
    .slice(0, bytes);

interface Row {
  name: string;
  /** The most one reply of it may be. */
  bound: number;
  /** Store the data and read it all, page by page; returns what the pages gave back and expects. */
  read(store: Store, threadId: string, ask: Awaited<ReturnType<typeof connect>>): Promise<{
    replies: string[];
    got: unknown;
    stored: unknown;
  }>;
}

/** Every `item.raw` page of `item`, read as the raw view reads them. */
async function rawPages(item: Item, store: Store, threadId: string, ask: Awaited<ReturnType<typeof connect>>) {
  store.appendEvents(threadId as never, [{ type: "item.created", item }]);
  const replies: string[] = [];
  const got: unknown[] = [];
  let from: number | undefined = 0;
  let revision: string | undefined;
  while (from !== undefined) {
    const text = await ask({ type: "item.raw", threadId, itemId: item.id, from, ...(revision ? { revision } : {}) });
    replies.push(text);
    const page = ServerMessage.parse(JSON.parse(text));
    if (page.type !== "item.raw") throw new Error(`Unexpected ${page.type}`);
    got.push(...page.raw);
    revision = page.revision;
    from = page.next;
  }
  return { replies, got, stored: item.type === "message" ? item.raw : [] };
}

/** Every `output.read` of `streamId`, each asking for the most the protocol allows. */
async function outputReads(streamId: string, ask: Awaited<ReturnType<typeof connect>>) {
  const replies: string[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const text = await ask({ type: "output.read", streamId, offset, limit: 256 * 1024 });
    replies.push(text);
    const reply = ServerMessage.parse(JSON.parse(text));
    if (reply.type !== "output.data") throw new Error(`Unexpected ${reply.type}: ${text.slice(0, 200)}`);
    chunks.push(Buffer.from(reply.bytes, "base64"));
    if (reply.eof) break;
    offset = reply.nextOffset;
  }
  return { replies, bytes: Buffer.concat(chunks) };
}

const message = (id: string, raw: unknown[], text = "Done") =>
  Item.parse({
    id,
    agentId: root,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
    createdAt: 1,
    complete: true,
    raw,
  });

const rows: Row[] = [
  {
    name: "item.raw: many entries of the largest size storage keeps inline",
    bound: pageReplyBytes + envelopeBytes,
    read: (store, threadId, ask) =>
      rawPages(
        message(
          "many",
          Array.from({ length: 40 }, (_, index) => ({ type: "assistant", data: { index, text: words(60_000) } })),
        ),
        store,
        threadId,
        ask,
      ),
  },
  {
    name: "item.raw: many small entries",
    bound: pageReplyBytes + envelopeBytes,
    read: (store, threadId, ask) =>
      rawPages(
        message("small", Array.from({ length: 3000 }, (_, index) => ({ type: "delta", data: { index, text: words(200) } }))),
        store,
        threadId,
        ask,
      ),
  },
  {
    name: "item.raw: one entry that fills a page alone goes whole, by itself",
    bound: entryBytes + envelopeBytes,
    read: (store, threadId, ask) =>
      rawPages(
        message("alone", [
          { type: "assistant", name: "n".repeat(3000), data: { text: "x".repeat(64 * 1024 - 64) } },
          { type: "assistant", data: { text: "x".repeat(64 * 1024 - 64) } },
        ]),
        store,
        threadId,
        ask,
      ),
  },
  {
    name: "output.read: a shell's whole output, asked for in the largest reads allowed",
    bound: pageReplyBytes + envelopeBytes,
    async read(store, threadId, ask) {
      const id = ItemId.parse("shell");
      const output = words(700 * 1024);
      store.appendEvents(threadId as never, [
        {
          type: "item.created",
          item: Item.parse({
            id,
            agentId: root,
            type: "tool_call",
            createdAt: 1,
            complete: false,
            call: {
              id,
              agentId: root,
              kind: "shell",
              title: "make",
              status: "running",
              detail: { kind: "shell", command: "make" },
              startedAt: 1,
              raw: [],
            },
          }),
        },
        { type: "item.delta", itemId: id, agentId: root, field: "output", append: output },
      ]);
      const { replies, bytes } = await outputReads(`output:${id}`, ask);
      return { replies, got: bytes.toString("utf8"), stored: output };
    },
  },
  {
    name: "output.read: a long message's full text (UTF-16), in the largest reads allowed",
    bound: pageReplyBytes + envelopeBytes,
    async read(store, threadId, ask) {
      const text = words(300 * 1024);
      const [created] = store.appendEvents(threadId as never, [
        { type: "item.created", item: message("long", [], text) },
      ]);
      const streamId = `text:${JSON.stringify(["long", 0, created?.seq])}`;
      const { replies, bytes } = await outputReads(streamId, ask);
      return { replies, got: bytes.toString("utf16le"), stored: text };
    },
  },
];

test.each(rows)("$name: every reply stays within the bound, and reading on gives it all", async (row) => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const ask = await connect(f.server.url);
  const { replies, got, stored } = await row.read(f.store, f.thread.id, ask);
  expect(replies.length).toBeGreaterThan(1);
  const largest = Math.max(...replies.map((text) => Buffer.byteLength(text)));
  expect(largest).toBeLessThanOrEqual(row.bound);
  expect(got).toEqual(stored);
});
