import { afterEach, expect, it } from "vitest";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { parsePairingLink } from "@ace/client/access";
import {
  Command,
  DeviceId,
  PairingResponse,
  type ClientMessage,
  type ServerMessage,
} from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { message } from "./payload-test-support.ts";
import type { CommandHandler } from "./commands.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A provider at the boundary: every `thread.send` produces one answer in the thread. */
const answering: CommandHandler = {
  handle(command, store) {
    const payload = command.payload;
    if (payload.type !== "thread.send")
      return { commandId: command.id, ok: false, error: "not_implemented" };
    store.appendEvents(payload.threadId, [
      { type: "item.created", item: message(`answer-${command.id}`, "Done") },
    ]);
    return { commandId: command.id, ok: true };
  },
};

async function relayedDaemon() {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const f = await fixture({ relay: { url: relay.url, keys: keyPair() }, handler: answering });
  cleanup.push(() => f.close());
  const relayHostId = f.server.relayHostId;
  if (!relayHostId) throw new Error("Relay host missing");
  const hostId: string = relayHostId;
  /** A main channel through the relay, read message by message. */
  async function open() {
    const channel = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId,
      pinnedFingerprint: hostId,
    });
    cleanup.push(() => channel.close());
    return reader(channel);
  }
  return { f, relay, hostId, open };
}

function reader(channel: ClientChannel) {
  const seen: ServerMessage[] = [];
  return {
    channel,
    send: (outgoing: ClientMessage) => channel.send(outgoing),
    /** The next message `matches` accepts, skipping catalog and quota pushes. */
    async until<T extends ServerMessage>(
      matches:
        | ((incoming: ServerMessage) => incoming is T)
        | ((incoming: ServerMessage) => boolean),
    ): Promise<T> {
      const accept = (incoming: ServerMessage): incoming is T => matches(incoming);
      const earlier = seen.findIndex(accept);
      const kept = earlier >= 0 ? seen.splice(earlier, 1)[0] : undefined;
      if (kept && accept(kept)) return kept;
      while (true) {
        const incoming = await channel.receive();
        if (accept(incoming)) return incoming;
        seen.push(incoming);
      }
    },
  };
}

const ofType =
  <T extends ServerMessage["type"]>(type: T) =>
  (incoming: ServerMessage): incoming is Extract<ServerMessage, { type: T }> =>
    incoming.type === type;

function sendCommand(threadId: string, deviceId: string, id: string): ClientMessage {
  return {
    type: "command",
    command: Command.parse({
      id,
      deviceId,
      payload: {
        type: "thread.send",
        threadId,
        input: [{ type: "text", text: "Hello over the relay" }],
        delivery: "queue",
      },
    }),
  };
}

it("a paired device runs a turn over the relay and sees the answer arrive", async () => {
  const { f, open } = await relayedDaemon();
  const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  const client = await open();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: paired.device.id,
    token: paired.token,
    compression: ["deflate-raw"],
  });
  expect(await client.until(ofType("welcome"))).toMatchObject({ hostId: "host" });
  await client.send({
    type: "subscribe",
    subscriptionId: "thread",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  await client.until(ofType("snapshot"));
  await client.send(sendCommand(f.thread.id, paired.device.id, "turn-1"));
  expect(await client.until(ofType("commandResult"))).toMatchObject({ ok: true });
  const events = await client.until(
    (incoming) =>
      incoming.type === "events" &&
      incoming.events.some(
        (event) =>
          event.payload.type === "item.created" && event.payload.item.id === "answer-turn-1",
      ),
  );
  expect(events).toMatchObject({ subscriptionId: "thread" });
});

it("a device resumes from its cursor after the relay connection drops", async () => {
  const { f, open } = await relayedDaemon();
  const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  const hello: ClientMessage = {
    type: "hello",
    protocolVersion: 1,
    deviceId: paired.device.id,
    token: paired.token,
  };
  const first = await open();
  await first.send(hello);
  await first.until(ofType("welcome"));
  await first.send({
    type: "subscribe",
    subscriptionId: "thread",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  await first.until(ofType("snapshot"));
  const cursor = f.store.headSeq();
  first.channel.close();
  // The agent keeps working while the phone is away.
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: message("while-away") }]);

  const second = await open();
  await second.send(hello);
  await second.until(ofType("welcome"));
  await second.send({
    type: "subscribe",
    subscriptionId: "thread",
    scope: { kind: "thread", threadId: f.thread.id },
    afterSeq: cursor,
  });
  const replay = await second.until(
    (incoming) => incoming.type === "events" || incoming.type === "snapshot",
  );
  expect(replay.type).toBe("events");
  expect(replay).toMatchObject({
    events: expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "item.created",
          item: expect.objectContaining({ id: "while-away" }),
        }),
      }),
    ]),
  });
});

it("revoking a relayed device closes its main channel with the revocation code", async () => {
  const { f, open } = await relayedDaemon();
  const paired = f.store.devices.create("Phone", ["read"], Date.now());
  const client = await open();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: paired.device.id,
    token: paired.token,
  });
  await client.until(ofType("welcome"));
  await accessRequest(f.server.httpUrl, `/v1/devices/${paired.device.id}`, {
    method: "DELETE",
    token,
  });
  expect(await client.until(ofType("channel.close"))).toMatchObject({ code: 4003 });
  await expect(client.channel.closed).resolves.toBeDefined();
});

it("a relayed hello with a wrong credential is refused before welcome", async () => {
  const { open } = await relayedDaemon();
  const client = await open();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("stranger"),
    token: "0".repeat(64),
  });
  expect(await client.channel.receive()).toMatchObject({ type: "error", code: "unauthorized" });
  await expect(client.channel.closed).resolves.toBeDefined();
});

it("a device pairs through a self-hosted relay with a single-use code and the host's scopes", async () => {
  const { f, open } = await relayedDaemon();
  const issued = PairingResponse.parse(
    await accessRequest(f.server.httpUrl, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read"] },
    }),
  );
  const link = parsePairingLink(issued.url);
  expect(link.relay?.hostId).toBe(f.server.relayHostId);
  const redeem = async () => {
    const channel = await open();
    await channel.send({ type: "pair.redeem", code: link.code, name: "Tablet" });
    return channel.until(ofType("pair.result"));
  };
  const redeemed = await redeem();
  if (!redeemed.result.ok) throw new Error("Pairing was refused");
  expect(redeemed.result.device).toMatchObject({ name: "Tablet", scopes: ["read"] });
  expect((await redeem()).result).toMatchObject({ ok: false, error: "invalid" });

  const client = await open();
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: redeemed.result.device.id,
    token: redeemed.result.token,
  });
  await client.until(ofType("welcome"));
  // The code carried read only; acting on the thread stays forbidden.
  await client.send(sendCommand(f.thread.id, redeemed.result.device.id, "not-allowed"));
  expect(await client.until(ofType("error"))).toMatchObject({ code: "forbidden" });
  // Nor can it read or change the machine code.
  await client.send({ type: "machine.code.clear", requestId: "clear" });
  expect(await client.until(ofType("machine.code.result"))).toMatchObject({
    result: { ok: false, error: "forbidden" },
  });
});
