import { expect, it } from "vitest";
import { NoiseXX, fingerprint, keyPair } from "@ace/secure-channel";
import { decodeKeyBlock } from "@ace/media/key-block";
import { STREAM_PROLOGUE } from "@ace/relay/wire";
import { HostId } from "@ace/protocol";
import type { ToMedia } from "@ace/media/wire";
import {
  HANDOVER_DEADLINE_MS,
  MAX_PENDING_STREAMS,
  MediaRelayStreams,
  type AdmitMediaHello,
} from "./streams.ts";

const host = keyPair();
const grant = {
  connection: "mc_relayed01",
  owner: { session: "s1", device: "phone", admission: { kind: "pairing", generation: 1 } },
  issued: 7,
} as const;
const admitAll: AdmitMediaHello = async () => ({
  ok: true,
  grant,
  welcome: {
    type: "welcome",
    hostId: HostId.parse(fingerprint(host.publicKey)),
    protocolVersion: 1,
    headSeq: 0,
  },
});

/** A fake ace-media that records what the daemon sends and plays one scripted client. */
function harness(options: { accepts?: boolean } = {}) {
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
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

it("offers are turned down while ace-media can't dial, or too many are pending", () => {
  const down = harness({ accepts: false });
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
