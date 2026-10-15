import { afterEach, expect, test } from "vitest";
import { ThreadId, type CommandPayload, type CommandResult } from "@ace/protocol";
import { scripted, type Peer } from "./scripted-server.fixture.ts";
import { when } from "./test-support.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const bound = 60_000;
const archive: CommandPayload = { type: "thread.archive", threadId: ThreadId.parse("thread") };

/** A client welcomed by a scripted daemon that never answers its commands on its own. */
async function connected(limits: Parameters<typeof scripted>[0] = {}) {
  const h = await scripted({ commandStatusMs: bound, ...limits });
  close = h.close;
  void h.client.start();
  const peer = await h.connection(0);
  await peer.next("hello");
  peer.welcome();
  await when(h.client.connectionState(), (state) => state === "ready");
  return { ...h, peer };
}

/** Everything the daemon sent before this point has reached the client. */
async function barrier(client: { itemsPage(input: object): Promise<unknown> }, peer: Peer) {
  const read = client.itemsPage({ threadId: "thread", limit: 1 });
  const request = await peer.next("items.page");
  peer.send({
    type: "items.page",
    requestId: request.requestId,
    seq: 0,
    threadId: "thread",
    items: [],
    itemsBefore: null,
  });
  await read;
}

test("a durable command the daemon has no record of fails visibly", async () => {
  const { client, scheduler, peer } = await connected();
  const result = client.command(archive);
  const { command } = await peer.next("command");
  scheduler.advance(bound);
  const ask = await peer.next("command.status");
  expect(ask.commandIds).toEqual([command.id]);
  peer.send({
    type: "command.status",
    requestId: ask.requestId,
    commands: [{ commandId: command.id, state: "unknown" }],
  });
  await expect(result).resolves.toMatchObject({ ok: false, error: "command_lost" });
  expect(client.intent(command.id).getSnapshot()).toMatchObject({
    state: "failed",
    error: "command_lost",
  });
});

test("a durable command the daemon is still running keeps waiting", async () => {
  const { client, scheduler, peer } = await connected();
  let settled: CommandResult | undefined;
  const result = client.command(archive).then((value) => (settled = value));
  const { command } = await peer.next("command");
  scheduler.advance(bound);
  const first = await peer.next("command.status");
  peer.send({
    type: "command.status",
    requestId: first.requestId,
    commands: [{ commandId: command.id, state: "running" }],
  });
  await barrier(client, peer);
  expect(settled).toBeUndefined();
  // Still pending, with the "still waiting" hint, and asked about again after another bound.
  expect(client.intent(command.id).getSnapshot()).toMatchObject({
    state: "pending",
    waiting: true,
  });
  scheduler.advance(bound);
  const again = await peer.next("command.status");
  expect(again.commandIds).toEqual([command.id]);
  peer.send({ type: "commandResult", commandId: command.id, ok: true });
  await expect(result).resolves.toMatchObject({ ok: true });
  expect(client.intent(command.id).getSnapshot()?.state).toBe("acked");
});

test("a daemon that can't answer command.status never fails the command", async () => {
  const { client, scheduler, peer } = await connected();
  const result = client.command(archive);
  const { command } = await peer.next("command");
  scheduler.advance(bound);
  const ask = await peer.next("command.status");
  // What a daemon that doesn't know the message, or can't say, answers.
  peer.send({
    type: "error",
    requestId: ask.requestId,
    code: "invalid_message",
    message: "Message does not match the protocol",
  });
  await barrier(client, peer);
  scheduler.advance(bound * 3);
  await barrier(client, peer);
  expect(peer.received.filter((frame) => frame.type === "command.status")).toHaveLength(1);
  expect(client.intent(command.id).getSnapshot()?.state).toBe("pending");
  peer.send({ type: "commandResult", commandId: command.id, ok: true });
  await expect(result).resolves.toMatchObject({ ok: true });
});

test("a command refused for a retry later isn't asked after while it waits to resend", async () => {
  // A retry backoff (here 5 minutes) longer than the status bound.
  const retryMs = 10 * bound;
  const { client, scheduler, peer } = await connected({
    retryBaseMs: retryMs,
    retryCapMs: retryMs,
  });
  // Closing the client at the end settles the wait as offline.
  void client.command(archive).catch(() => {});
  const { command } = await peer.next("command");
  peer.send({
    type: "error",
    commandId: command.id,
    code: "maintenance",
    message: "Updating",
    retryable: true,
  });
  await barrier(client, peer);
  scheduler.advance(bound);
  await barrier(client, peer);
  expect(peer.received.filter((frame) => frame.type === "command.status")).toEqual([]);
  expect(client.intent(command.id).getSnapshot()?.state).toBe("pending");
  // Once resent it waits a whole bound of its own before it's asked after.
  scheduler.advance(retryMs / 2 - bound);
  const resent = await peer.next("command");
  expect(resent.command.id).toBe(command.id);
  scheduler.advance(bound);
  expect((await peer.next("command.status")).commandIds).toEqual([command.id]);
});
