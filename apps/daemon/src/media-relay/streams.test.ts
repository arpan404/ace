import { expect, it } from "vitest";
import { NoiseXX, fingerprint, keyPair } from "@ace/secure-channel";
import { decodeKeyBlock } from "@ace/media/key-block";
import { STREAM_PROLOGUE } from "@ace/relay/wire";
import { HostId } from "@ace/protocol";
import type { ToMedia } from "@ace/media/wire";
import {
  DIAL_RETRY_MS,
  HANDOVER_DEADLINE_MS,
  MAX_PENDING_STREAMS,
  MediaRelayStreams,
  REFUSAL_LINGER_MS,
  type AdmitMediaHello,
} from "./streams.ts";

const host = keyPair();
const grant = {
  connection: "mc_relayed01",
  owner: { session: "s1", device: "phone", admission: { kind: "pairing", generation: "g1" } },
  issued: 7,
} as const;
const granted: Awaited<ReturnType<AdmitMediaHello>> = {
  ok: true,
  grant,
  welcome: {
    type: "welcome",
    hostId: HostId.parse(fingerprint(host.publicKey)),
    protocolVersion: 1,
    headSeq: 0,
  },
};
const admitAll: AdmitMediaHello = async () => granted;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake ace-media that records what the daemon sends and plays one scripted client. */
function harness(options: { accepts?: boolean; available?: boolean } = {}) {
  const sent: { message: ToMedia; payload: Uint8Array }[] = [];
  const closed: string[] = [];
  const timers: { at: number; run: () => void }[] = [];
  let now = 0;
  let needs = 0;
  let next = 0;
  const toClient: Uint8Array[] = [];
  const streams = new MediaRelayStreams({
    link: {
      send(message, payload = new Uint8Array(0)) {
        if (options.accepts === false) return false;
        sent.push({ message, payload });
        if (message.type === "relay.out") toClient.push(payload.slice());
        return true;
      },
      closeStream: (message) => closed.push(message.stream),
      need() {
        needs++;
        return () => needs--;
      },
      available: () => options.available !== false,
    },
    clock: {
      now: () => now,
      setTimeout(run, ms) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    },
    hostKeys: host,
    ephemeralKey: keyPair,
    newId: () => String(next++),
    log: () => {},
  });
  return {
    streams,
    sent,
    closed,
    needs: () => needs,
    toClient,
    settle,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) timer.run();
    },
    /** ace-media answers the daemon's latest pull with `frame`. */
    async deliver(stream: string, frame: Uint8Array) {
      await settle();
      const pulls = sent.filter((s) => s.message.type === "relay.pull").length;
      expect(pulls).toBeGreaterThan(0);
      streams.onMessage({ type: "relay.in", stream }, frame);
      await settle();
    },
  };
}

function streamOf(h: ReturnType<typeof harness>): string {
  const dial = h.sent.find((s) => s.message.type === "relay.dial")?.message;
  if (dial?.type !== "relay.dial") throw new Error("no dial");
  return dial.stream;
}

it("a dialed stream is handed over through ace-media and its keys go out as relay.keys", async () => {
  const h = harness();
  expect(h.streams.offer("ws://relay/join?ticket=t", admitAll)).toBe(true);
  const stream = streamOf(h);
  h.streams.onMessage({ type: "relay.dialed", stream }, new Uint8Array(0));
  const client = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    prologue: STREAM_PROLOGUE,
  });
  await h.deliver(stream, client.writeMessage());
  await h.settle();
  client.readMessage(h.toClient.shift() ?? new Uint8Array());
  await h.deliver(stream, client.writeMessage());
  const hello = new TextEncoder().encode(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: "phone",
      channel: "media",
      token: "t",
      mediaTicket: "A".repeat(43),
    }),
  );
  await h.deliver(stream, client.transport.send.encrypt(Uint8Array.of(1, ...hello)));
  await h.settle();
  const keys = h.sent.find((s) => s.message.type === "relay.keys");
  expect(keys?.message).toEqual({ type: "relay.keys", stream, ...grant });
  expect(decodeKeyBlock(keys?.payload ?? new Uint8Array()).framesReceived).toBe(1n);
  expect(h.closed).toEqual([]);
  // ace-media stays up while the relayed connection is open, and may stop once it closes.
  expect(h.needs()).toBe(1);
  h.streams.onMessage(
    { type: "connection.closed", connection: grant.connection, reason: "x" },
    new Uint8Array(0),
  );
  expect(h.needs()).toBe(0);
});

it("a stream that misses the handover deadline is closed and lets ace-media go", async () => {
  const h = harness();
  h.streams.offer("ws://relay/join?ticket=t", admitAll);
  const stream = streamOf(h);
  h.advance(HANDOVER_DEADLINE_MS);
  await h.settle();
  expect(h.closed).toEqual([stream]);
  expect(h.needs()).toBe(0);
  expect(h.streams.pending).toBe(0);
});

it("a stream ace-media couldn't dial is closed with no handshake sent", async () => {
  const h = harness();
  h.streams.offer("ws://relay/join?ticket=t", admitAll);
  const stream = streamOf(h);
  h.streams.onMessage({ type: "relay.failed", stream, reason: "dial" }, new Uint8Array(0));
  await h.settle();
  expect(h.closed).toEqual([stream]);
  expect(h.sent.some((s) => s.message.type === "relay.out")).toBe(false);
});

it("offers are turned down while ace-media is unavailable, or too many are pending", () => {
  const down = harness({ available: false });
  expect(down.streams.offer("ws://relay/join", admitAll)).toBe(false);
  expect(down.needs()).toBe(0);
  const busy = harness();
  for (let i = 0; i < MAX_PENDING_STREAMS; i++)
    expect(busy.streams.offer("ws://relay/join", admitAll)).toBe(true);
  expect(busy.streams.offer("ws://relay/join", admitAll)).toBe(false);
});

it("ace-media exiting mid-handover ends the stream", async () => {
  const h = harness();
  h.streams.offer("ws://relay/join?ticket=t", admitAll);
  h.streams.onExit();
  await h.settle();
  expect(h.needs()).toBe(0);
  expect(h.streams.pending).toBe(0);
});

it("a stream offered while ace-media starts is dialed once its lanes are up", async () => {
  const options = { accepts: false };
  const h = harness(options);
  expect(h.streams.offer("ws://relay/join?ticket=t", admitAll)).toBe(true);
  expect(h.needs()).toBe(1);
  expect(h.sent).toHaveLength(0);
  options.accepts = true;
  h.advance(DIAL_RETRY_MS);
  await h.settle();
  expect(streamOf(h)).toMatch(/^rs_/);
});

const refuse: AdmitMediaHello = async () => ({
  ok: false,
  refusal: { type: "error", code: "unauthorized", message: "Valid hello required" },
});

it("a refused stream stays open just long enough for its refusal to be written first", async () => {
  const h = harness();
  h.streams.offer("ws://relay/join?ticket=t", refuse);
  const stream = streamOf(h);
  h.streams.onMessage({ type: "relay.dialed", stream }, new Uint8Array(0));
  const client = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    prologue: STREAM_PROLOGUE,
  });
  await h.deliver(stream, client.writeMessage());
  await h.settle();
  client.readMessage(h.toClient.shift() ?? new Uint8Array());
  await h.deliver(stream, client.writeMessage());
  const hello = JSON.stringify({
    type: "hello",
    protocolVersion: 1,
    deviceId: "phone",
    channel: "media",
    token: "t",
    mediaTicket: "A".repeat(43),
  });
  await h.deliver(
    stream,
    client.transport.send.encrypt(Uint8Array.of(1, ...new TextEncoder().encode(hello))),
  );
  await h.settle();
  expect(h.toClient).toHaveLength(1);
  expect(h.closed).toEqual([]);
  h.advance(REFUSAL_LINGER_MS);
  expect(h.closed).toEqual([stream]);
});

it("a stream ace-media couldn't dial turns the relay's ticket down at once; a joined one never does", async () => {
  const failing = harness();
  let rejected = 0;
  failing.streams.offer("wss://relay/join?ticket=t", admitAll, () => rejected++);
  const stream = streamOf(failing);
  failing.streams.onMessage({ type: "relay.failed", stream, reason: "tls" }, new Uint8Array(0));
  await failing.settle();
  expect(rejected).toBe(1);

  const joined = harness();
  joined.streams.offer("ws://relay/join?ticket=t", admitAll, () => rejected++);
  joined.streams.onMessage({ type: "relay.dialed", stream: streamOf(joined) }, new Uint8Array(0));
  joined.advance(HANDOVER_DEADLINE_MS);
  await joined.settle();
  expect(rejected).toBe(1);
});

it("a stream whose admission outlasts the deadline is closed, and its late admission hands over no keys", async () => {
  const h = harness();
  const admission = Promise.withResolvers<Awaited<ReturnType<AdmitMediaHello>>>();
  let seen: AbortSignal | undefined;
  h.streams.offer("ws://relay/join?ticket=t", (_hello, signal) => {
    seen = signal;
    return admission.promise;
  });
  const stream = streamOf(h);
  h.streams.onMessage({ type: "relay.dialed", stream }, new Uint8Array(0));
  const client = new NoiseXX({
    initiator: true,
    staticKey: keyPair(),
    ephemeralKey: keyPair(),
    prologue: STREAM_PROLOGUE,
  });
  await h.deliver(stream, client.writeMessage());
  await h.settle();
  client.readMessage(h.toClient.shift() ?? new Uint8Array());
  await h.deliver(stream, client.writeMessage());
  const hello = JSON.stringify({
    type: "hello",
    protocolVersion: 1,
    deviceId: "phone",
    channel: "media",
    token: "t",
    mediaTicket: "A".repeat(43),
  });
  await h.deliver(
    stream,
    client.transport.send.encrypt(Uint8Array.of(1, ...new TextEncoder().encode(hello))),
  );
  expect(seen?.aborted).toBe(false);
  const outBefore = h.sent.filter((s) => s.message.type === "relay.out").length;
  h.advance(HANDOVER_DEADLINE_MS);
  await h.settle();
  expect(h.closed).toEqual([stream]);
  expect(seen?.aborted).toBe(true);
  // Admission finishes after the stream was given up: nothing more goes to ace-media.
  admission.resolve(granted);
  await h.settle();
  await h.settle();
  expect(h.sent.some((s) => s.message.type === "relay.keys")).toBe(false);
  expect(h.sent.filter((s) => s.message.type === "relay.out").length).toBe(outBefore);
});
