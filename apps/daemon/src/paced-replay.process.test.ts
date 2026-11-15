import { once } from "node:events";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { ServerMessage, type ClientMessage } from "@ace/protocol";
import { message } from "./payload-test-support.ts";
import { setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

// The wiring a unit test of `subscribe` cannot show: a remote client that asks for paced
// replays gets its resume in acknowledged pieces, made only as it acknowledges them; a loopback
// client, or one that does not ask, gets the replay as before.

async function socketAt(url: string) {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    for (const line of data.toString().split("\n"))
      messages.push(ServerMessage.parse(JSON.parse(line)));
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "open");
  let read = 0;
  return {
    send: (sent: ClientMessage) => socket.send(JSON.stringify(sent)),
    async next(match: (sent: ServerMessage) => boolean, ms = 3000): Promise<ServerMessage> {
      const deadline = Date.now() + ms;
      for (;;) {
        while (read < messages.length) {
          const sent = messages[read++];
          if (sent && match(sent)) return sent;
        }
        if (Date.now() > deadline) throw new Error("Nothing more arrived");
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 50);
        });
      }
    },
    close: () => socket.close(),
  };
}

async function resume(framing: string[], remote: boolean) {
  const f = await setup();
  // History the client already holds, large enough that a snapshot never beats the replay.
  for (let index = 0; index < 60; index++)
    f.store.appendEvents(f.thread.id, [
      { type: "item.created", item: message(`old${index}`, "o".repeat(4000)) },
    ]);
  const cursor = f.store.headSeq();
  for (let index = 0; index < 120; index++)
    f.store.appendEvents(f.thread.id, [
      { type: "item.created", item: message(`m${index}`, "x".repeat(400)) },
    ]);
  let hello: Record<string, unknown> = { type: "hello", protocolVersion: 1, framing };
  let url = f.server.url;
  if (remote) {
    const paired = await f.pair(["read"]);
    const ticket = await f.ticket(paired.token);
    hello = { ...hello, deviceId: paired.device.id, ticket: ticket.ticket };
    url = f.server.remoteUrl;
  } else hello = { ...hello, deviceId: "desktop", token };
  const client = await socketAt(url);
  client.send(hello as ClientMessage);
  await client.next((sent) => sent.type === "welcome");
  client.send({
    type: "subscribe",
    subscriptionId: "resume",
    scope: { kind: "thread", threadId: f.thread.id },
    afterSeq: cursor,
  });
  return { f, client };
}

const isReplay = (sent: ServerMessage) =>
  sent.type === "events" && sent.subscriptionId === "resume";

test("a remote client that asks gets its resume in pieces, each made once it acknowledged enough", async () => {
  const { f, client } = await resume(["lines", "paced-replay"], true);
  const first = await client.next(isReplay);
  if (first.type !== "events") throw new Error("shape");
  expect(first.ack).toBe(true);
  expect(first.throughSeq).toBeLessThan(f.store.headSeq());
  // Without an acknowledgement, at most the rest of the first budget follows.
  const before: ServerMessage[] = [first];
  for (;;) {
    const more = await client.next(isReplay, 300).catch(() => undefined);
    if (!more) break;
    before.push(more);
  }
  const last = before.at(-1);
  if (last?.type !== "events") throw new Error("shape");
  expect(last.throughSeq).toBeLessThan(f.store.headSeq());
  // Acknowledging, piece by piece, brings the rest, in order, to the head.
  let cursor = last.throughSeq;
  client.send({ type: "events.received", subscriptionId: "resume", throughSeq: cursor });
  while (cursor < f.store.headSeq()) {
    const piece = await client.next(isReplay);
    if (piece.type !== "events") throw new Error("shape");
    expect(piece.afterSeq).toBe(cursor);
    cursor = piece.throughSeq;
    client.send({ type: "events.received", subscriptionId: "resume", throughSeq: cursor });
  }
  client.close();
});

test.each([
  { name: "a loopback client that asks", framing: ["lines", "paced-replay"], remote: false },
  { name: "a remote client that does not ask", framing: ["lines"], remote: true },
])("$name gets the whole resume at once, unmarked", async ({ framing, remote }) => {
  const { f, client } = await resume(framing, remote);
  const replay = await client.next(isReplay);
  if (replay.type !== "events") throw new Error("shape");
  expect(replay.ack).toBeUndefined();
  expect(replay.throughSeq).toBe(f.store.headSeq());
  client.close();
});
