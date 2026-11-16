import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { NoiseNK, keyPair } from "@ace/secure-channel";
import type { Clock } from "./clock.ts";
import { answerNk, refusalDeadline, type NkAccepted, type NkHost } from "./nk-stream.ts";
import { NK_REFUSAL_MS, NK_STREAM_PROLOGUE } from "./wire.ts";

// Every refusal of an NK first message (ADR 0155, step 2) closes the stream at one fixed
// deadline from the message's arrival, whatever the daemon's check does, and an admission that
// settles past it is abandoned. Driven by the relay's injected clock: no real waiting.

function fakeClock(start = 1_000) {
  let now = start;
  const timers: { at: number; run: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    schedule(ms, run) {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    for (let n = 0; n < 5; n++) await Promise.resolve();
  };
  return { clock, advance, setNow: (to: number) => (now = to) };
}

/** A socket the relay answers on: what it sends and when it is cut. */
function fakeSocket() {
  const record = { sent: [] as Uint8Array[], terminatedAt: undefined as number | undefined };
  let clock: Clock | undefined;
  const socket = {
    readyState: 1,
    OPEN: 1,
    send(data: Uint8Array, _options: unknown, done?: (error?: Error) => void) {
      record.sent.push(data);
      done?.();
    },
    terminate() {
      record.terminatedAt ??= clock?.now();
    },
  } as unknown as WebSocket;
  return { socket, record, watch: (c: Clock) => (clock = c) };
}

const host = keyPair();
const firstMessage = () =>
  NoiseNK.initiator({
    remoteStatic: host.publicKey,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  }).writeMessage(new TextEncoder().encode("{}"));

const never = new Promise<undefined>(() => {});
const cases: [string, () => NkHost][] = [
  ["a check that never finishes", () => ({ arrive: () => true, admit: () => never })],
  ["an immediate refusal", () => ({ arrive: () => true, admit: async () => undefined })],
  ["a daemon over its rate", () => ({ arrive: () => false, admit: async () => undefined })],
  [
    "a check that throws",
    () => ({
      arrive: () => true,
      admit: async () => {
        throw new Error("Daemon failed");
      },
    }),
  ],
];

it.each(cases)(
  "%s: the stream is cut exactly at the deadline, with nothing sent",
  async (_name, nk) => {
    const time = fakeClock();
    const peer = fakeSocket();
    peer.watch(time.clock);
    const arrivedAt = time.clock.now();
    const answered = answerNk(peer.socket, firstMessage(), {
      host: nk(),
      staticKey: host,
      clock: time.clock,
      signal: new AbortController().signal,
      arrivedAt,
    });
    await time.advance(NK_REFUSAL_MS - 1);
    expect(peer.record.terminatedAt).toBeUndefined();
    await time.advance(1);
    expect(await answered).toBeUndefined();
    expect(peer.record.terminatedAt).toBe(arrivedAt + NK_REFUSAL_MS);
    expect(peer.record.sent).toEqual([]);
  },
);

it("a first message that arrived a while ago is refused at its own deadline, not later", async () => {
  const time = fakeClock();
  const peer = fakeSocket();
  peer.watch(time.clock);
  const arrivedAt = time.clock.now() - 100;
  const answered = answerNk(peer.socket, firstMessage(), {
    host: { arrive: () => true, admit: async () => undefined },
    staticKey: host,
    clock: time.clock,
    signal: new AbortController().signal,
    arrivedAt,
  });
  await time.advance(NK_REFUSAL_MS - 100);
  expect(await answered).toBeUndefined();
  expect(peer.record.terminatedAt).toBe(arrivedAt + NK_REFUSAL_MS);
});

it("an admission that settles past the deadline is abandoned and the stream refused, never answered", async () => {
  const time = fakeClock();
  const peer = fakeSocket();
  peer.watch(time.clock);
  let abandoned = 0;
  let opened = 0;
  const accepted: NkAccepted = {
    open: () => {
      opened++;
    },
    abandon: () => {
      abandoned++;
    },
  };
  const arrivedAt = time.clock.now();
  const answered = answerNk(peer.socket, firstMessage(), {
    host: {
      arrive: () => true,
      // The daemon's work (or a stall) takes past the deadline, then admits.
      admit: async () => {
        time.setNow(arrivedAt + NK_REFUSAL_MS + 50);
        return accepted;
      },
    },
    staticKey: host,
    clock: time.clock,
    signal: new AbortController().signal,
    arrivedAt,
  });
  await time.advance(0);
  expect(await answered).toBeUndefined();
  expect(abandoned).toBe(1);
  expect(opened).toBe(0);
  expect(peer.record.sent).toEqual([]);
});

it("an admission in time is answered at once, before the deadline", async () => {
  const time = fakeClock();
  const peer = fakeSocket();
  peer.watch(time.clock);
  const answered = answerNk(peer.socket, firstMessage(), {
    host: { arrive: () => true, admit: async () => ({ open: () => {}, abandon: () => {} }) },
    staticKey: host,
    clock: time.clock,
    signal: new AbortController().signal,
    arrivedAt: time.clock.now(),
  });
  await time.advance(0);
  expect(await answered).toBeDefined();
  expect(peer.record.sent).toHaveLength(1);
  expect(peer.record.terminatedAt).toBeUndefined();
});

it("a daemon that doesn't take NK refuses at the same deadline", async () => {
  // The relay host's path for it: the shared deadline from arrival, then the cut.
  const time = fakeClock();
  const arrivedAt = time.clock.now();
  let reachedAt: number | undefined;
  void refusalDeadline(time.clock, arrivedAt, new AbortController().signal).reached.then(
    () => (reachedAt = time.clock.now()),
  );
  await time.advance(NK_REFUSAL_MS - 1);
  expect(reachedAt).toBeUndefined();
  await time.advance(1);
  expect(reachedAt).toBe(arrivedAt + NK_REFUSAL_MS);
});
