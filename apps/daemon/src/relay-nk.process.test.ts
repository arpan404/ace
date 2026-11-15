import { afterEach, expect, it } from "vitest";
import { startRelay } from "@ace/relay";
import { NK_STREAM_PROLOGUE, PAIRED_MARKER } from "@ace/relay/wire";
import { address, initiate, openPeer, STREAM } from "@ace/relay/testing";
import { CREDIT_FLAG, NoiseNK, keyPair, type SessionKeys } from "@ace/secure-channel";
import type { ServerMessage } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";

// A returning client opening its relay stream with Noise NK (ADR 0155, step 2), against the
// real self-hosted relay and the daemon's own relay host: one round trip to the welcome, nothing
// on the device until it confirms, and every attack named below refused or confined.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** One relay stream: the marker read, then sealed JSON both ways. */
function stream(peer: Awaited<ReturnType<typeof openPeer>>, keys: SessionKeys) {
  const decoder = new TextDecoder();
  return {
    async send(message: unknown) {
      const body = json(message);
      const plain = new Uint8Array(body.length + 1);
      plain[0] = 1;
      plain.set(body, 1);
      await peer.send(keys.send.encrypt(plain));
    },
    /** The next JSON message, skipping credit fragments. */
    async receive(): Promise<ServerMessage> {
      for (;;) {
        const plain = keys.receive.decrypt(await peer.next());
        if (plain[0] === CREDIT_FLAG) continue;
        if (plain[0] !== 1) throw new Error(`Unexpected fragment ${plain[0]}`);
        return JSON.parse(decoder.decode(plain.subarray(1))) as ServerMessage;
      }
    },
    async until<T extends ServerMessage["type"]>(type: T) {
      for (;;) {
        const message = await this.receive();
        if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
      }
    },
  };
}

async function relayedDaemon() {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const relayKeys = keyPair();
  const hostKey = relayKeys.publicKey.slice();
  const f = await fixture({ relay: { url: relay.url, keys: relayKeys } });
  cleanup.push(() => f.close());
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  const dial = async () => {
    const peer = await openPeer(address(relay.url, "/client", { hostId }));
    cleanup.push(() => peer.close());
    expect([...(await peer.next())]).toEqual([PAIRED_MARKER]);
    return peer;
  };
  const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  /** Today's XX path with the device token; asks for the next ticket. */
  const xx = async () => {
    const peer = await dial();
    const keys = await initiate(peer, STREAM, keyPair(), hostId);
    const channel = stream(peer, keys);
    await channel.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      token: paired.token,
      nextTicket: true,
    });
    const welcome = await channel.until("welcome");
    return { peer, channel, welcome };
  };
  /** The NK first message for `early`, sent to `key`. */
  const firstMessage = (early: unknown, key: Uint8Array = hostKey) => {
    const noise = NoiseNK.initiator({
      remoteStatic: key,
      ephemeralKey: keyPair(),
      prologue: NK_STREAM_PROLOGUE,
    });
    return { noise, bytes: noise.writeMessage(json(early)) };
  };
  /** Sends `first` and waits for the daemon's answer; undefined when it closes instead. */
  const answered = async (first: Uint8Array) => {
    const peer = await dial();
    await peer.send(first);
    const answer = await peer.next().catch(() => undefined);
    return { peer, answer };
  };
  const nk = async (early: Record<string, unknown>, confirm: unknown = { type: "hello.confirm" }) => {
    const { noise, bytes } = firstMessage(early);
    const { peer, answer } = await answered(bytes);
    if (!answer) return undefined;
    expect(noise.readMessage(answer)).toHaveLength(0);
    const channel = stream(peer, noise.transport);
    if (confirm) await channel.send(confirm);
    return { peer, channel };
  };
  const earlyHello = (ticket: string, extra: Record<string, unknown> = {}) => ({
    type: "hello.early",
    protocolVersion: 1,
    deviceId: paired.device.id,
    ticket,
    ...extra,
  });
  return { f, relay, hostId, hostKey, paired, xx, nk, firstMessage, answered, earlyHello };
}

it("a returning device is welcomed one round trip after its NK first message, and confirmed sessions work as today", async () => {
  const h = await relayedDaemon();
  const first = await h.xx();
  // The XX welcome over the relay announces NK and hands the next ticket.
  expect(first.welcome.relayHandshakes).toEqual(["nk1"]);
  const ticket = first.welcome.ticket?.ticket;
  if (!ticket) throw new Error("No ticket handed");
  const opened = await h.nk(
    h.earlyHello(ticket, {
      flowControl: ["credit"],
      subscribes: [
        { subscriptionId: "thread", scope: { kind: "thread", threadId: h.f.thread.id } },
      ],
    }),
    { type: "hello.confirm", nextTicket: true },
  );
  if (!opened) throw new Error("NK refused");
  const welcome = await opened.channel.until("welcome");
  expect(welcome).toMatchObject({ hostId: "host", relayHandshakes: ["nk1"] });
  expect(welcome.ticket).toBeUndefined();
  // The early subscribe's snapshot, and the next ticket once confirmed.
  expect(await opened.channel.until("snapshot")).toMatchObject({ subscriptionId: "thread" });
  const confirmed = await opened.channel.until("hello.confirmed");
  expect(confirmed.ticket?.ticket).toMatch(/^[0-9a-f]{64}$/);
  // A confirmed session reads what the client sends: a ping, then a page.
  await opened.channel.send({ type: "ping" });
  expect(await opened.channel.until("pong")).toEqual({ type: "pong" });
  // The handed ticket opens the next NK session too.
  const again = await h.nk(h.earlyHello(confirmed.ticket?.ticket ?? ""));
  expect(await again?.channel.until("welcome")).toMatchObject({ type: "welcome" });
});

it("a replayed first message opens nothing readable, and the real client's next attempt over XX works", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  const recorded = h.firstMessage(h.earlyHello(ticket));
  const real = await h.answered(recorded.bytes);
  expect(real.answer).toBeDefined();
  // The recorder sends the same bytes again: refused (the same key, and the ticket is spent).
  const replay = await h.answered(recorded.bytes);
  expect(replay.answer).toBeUndefined();
  // A recorder holds no ephemeral key: even the real answer is unreadable to a fresh initiator.
  const guess = NoiseNK.initiator({
    remoteStatic: h.hostKey,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  });
  guess.writeMessage();
  expect(() => guess.readMessage(real.answer ?? new Uint8Array())).toThrow();
  expect((await h.xx()).welcome.type).toBe("welcome");
});

it("an early copy racing the real client wins the ticket but can't confirm, and the real client recovers over XX", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  // The copy goes first with its own ephemeral key (a relay re-sealing the payload can't: it is
  // encrypted to the daemon's key; this is the strongest copy, made by someone who held it).
  const copy = await h.answered(h.firstMessage(h.earlyHello(ticket)).bytes);
  expect(copy.answer).toBeDefined();
  const real = await h.answered(h.firstMessage(h.earlyHello(ticket)).bytes);
  expect(real.answer).toBeUndefined();
  const recovered = await h.xx();
  expect(recovered.welcome.relayHandshakes).toEqual(["nk1"]);
  expect(recovered.welcome.ticket).toBeDefined();
});

it("a session that never confirms is closed after 5 s, having written nothing for the device and viewed no thread", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  const before = h.f.store.devices.list().find((device) => device.id === h.paired.device.id);
  const opened = await h.nk(
    h.earlyHello(ticket, {
      subscribes: [
        { subscriptionId: "thread", scope: { kind: "thread", threadId: h.f.thread.id } },
      ],
    }),
    null,
  );
  if (!opened) throw new Error("NK refused");
  expect(await opened.channel.until("snapshot")).toMatchObject({ subscriptionId: "thread" });
  // Held for the snapshot, but not a viewer: no workspace refresh follows from it.
  expect(h.f.store.viewedThreads()).not.toContain(h.f.thread.id);
  const started = Date.now();
  await opened.peer.closed;
  expect(Date.now() - started).toBeLessThan(6_000);
  const after = h.f.store.devices.list().find((device) => device.id === h.paired.device.id);
  expect(after?.lastSeenAt).toBe(before?.lastSeenAt);
  expect(h.f.store.viewedThreads()).toEqual([]);
}, 15_000);

it("a first payload carrying an excluded field is refused like any other", async () => {
  const h = await relayedDaemon();
  for (const extra of [
    { token: h.paired.token },
    { installId: "install" },
    { nextTicket: true },
    { channel: "files" },
  ]) {
    const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
    expect(await h.nk(h.earlyHello(ticket, extra))).toBeUndefined();
    // The refusal burned nothing: the ticket still opens a clean first message.
    expect(await h.nk(h.earlyHello(ticket))).toBeDefined();
  }
});

it("a first message for a revoked device is refused, its outstanding ticket with it", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  h.f.store.devices.revoke(h.paired.device.id, Date.now());
  expect(await h.nk(h.earlyHello(ticket))).toBeUndefined();
});

it("a first message sealed to a key the daemon no longer holds is refused", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  const stale = await h.answered(h.firstMessage(h.earlyHello(ticket), keyPair().publicKey).bytes);
  expect(stale.answer).toBeUndefined();
});

it("a flood of invalid first messages is refused alike while a confirmed session keeps working", async () => {
  const h = await relayedDaemon();
  const ticket = (await h.xx()).welcome.ticket?.ticket ?? "";
  const confirmed = await h.nk(h.earlyHello(ticket));
  await confirmed?.channel.until("welcome");
  const refusals = await Promise.all(
    Array.from({ length: 24 }, async (_, n) => {
      const started = Date.now();
      const junk = new Uint8Array(48 + n).map(() => n);
      const { answer } = await h.answered(junk);
      return { answer, took: Date.now() - started };
    }),
  );
  expect(refusals.every(({ answer }) => answer === undefined)).toBe(true);
  await confirmed?.channel.send({ type: "ping" });
  expect(await confirmed?.channel.until("pong")).toEqual({ type: "pong" });
}, 20_000);
