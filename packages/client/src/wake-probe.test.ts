import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { connected, pass, settle, type Clock } from "./path-switch.fixture.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Longer than the gap between a probe's answer and its 5 s deadline, so only the probe decides. */
const beatMs = 3_000;

/**
 * A ready connection on manual time whose daemon answers pings only when told, or each one
 * promptly (`answering`).
 */
async function ready(answering = false) {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  let events: TransportEvents | undefined;
  let pings = 0;
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("phone"),
      transport: () => ({
        open(next) {
          events = next;
          next.open();
        },
        send(text) {
          if (JSON.parse(text).type !== "ping") return;
          pings++;
          if (answering) queueMicrotask(() => events?.message(JSON.stringify({ type: "pong" })));
        },
        close() {},
      }),
      credential: async () => "a".repeat(64),
      storage: { load: async () => null, save: async () => {} },
      scheduler: {
        set(delay, run) {
          const timer = { at: now + delay, run };
          timers.add(timer);
          return () => void timers.delete(timer);
        },
      },
      random: () => 0.5,
      id: () => "id",
      now: () => now,
      // The heartbeat's monotonic clock: this test's manual time.
      monotonic: () => now,
    },
    new WireCodec(),
    { ...defaultLimits, heartbeatMs: beatMs },
    () => {},
    () => {},
    () => {},
  );
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
    }
    now = until;
  };
  connection.start();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const frame = (message: object) => events?.message(JSON.stringify(message));
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  expect(connection.state).toBe("ready");
  return { connection, advance, pong: () => frame({ type: "pong" }), pings: () => pings };
}

test("a pong for a ping sent before a wake does not answer the wake's probe", async () => {
  const h = await ready();
  // The regular beat pings at 3 s; its pong is still on the way when the app is woken.
  h.advance(beatMs);
  expect(h.pings()).toBe(1);
  h.connection.wake();
  // The old pong lands: it answers the old ping, not the wake.
  h.advance(100);
  h.pong();
  // The wake came within 300 ms of the beat's ping: its own ping goes when that window ends.
  h.advance(200);
  expect(h.pings()).toBe(2);
  // The network changed under the socket: nothing more comes back. Dropped 5 s after that ping.
  h.advance(4_900);
  expect(h.connection.state).toBe("ready");
  h.advance(200);
  expect(h.connection.state).toBe("reconnecting");
});

test("the pong for the probe's own ping answers it", async () => {
  const h = await ready();
  h.advance(beatMs);
  h.connection.wake();
  h.advance(100);
  // Both pongs, in order: the old ping's, then the probe's.
  h.pong();
  h.pong();
  // Past the probe's 5 s deadline, before the regular beat could find the socket silent.
  h.advance(5_000);
  expect(h.connection.state).toBe("ready");
});

test("wakes at 0, 2 and 4 s on a dead socket drop it at 5 s, not later", async () => {
  const h = await ready();
  // A flapping network: the host wakes the client on every interface change.
  h.connection.wake();
  h.advance(2_000);
  h.connection.wake();
  h.advance(2_000);
  h.connection.wake();
  h.advance(900);
  expect(h.connection.state).toBe("ready");
  h.advance(100);
  expect(h.connection.state).toBe("reconnecting");
});

test("each wake's own ping must be answered: an answer to the first doesn't cover the last", async () => {
  const h = await ready();
  h.connection.wake();
  h.advance(2_000);
  h.connection.wake();
  // The first probe's pong arrives; the second probe's never does.
  h.pong();
  h.advance(3_000);
  expect(h.connection.state).toBe("ready");
  h.advance(2_000);
  expect(h.connection.state).toBe("reconnecting");
});

test("a standby's own late pong does not answer a wake probe after the standby is promoted", async () => {
  const { clock, client, multipath, path } = await connected("lan", ["lan", "relay"]);
  const relay = path("relay");
  // The relay's pongs are held: its standby ping (30 s) is still unanswered at promotion.
  const held: (() => void)[] = [];
  relay.pongAfter = (deliver) => held.push(deliver);
  await pass(clock, 31_000);
  expect(held).toHaveLength(1);
  path("lan").last.drop();
  await settle();
  expect(multipath.active?.kind).toBe("relay");
  const promoted = relay.last;
  // Woken: the probe pings the promoted socket, then the link dies under it.
  client.wake();
  // The standby's old pong lands; it answers the standby's ping, not the probe's.
  held.shift()?.();
  await settle();
  clock.advance(4_900);
  await settle();
  expect(promoted.closed).toBe(false);
  clock.advance(200);
  await settle();
  expect(promoted.closed).toBe(true);
});

/** Let `ms` pass in `step` ms steps, letting pings and pongs (microtasks) run after each. */
async function wait(clock: Clock, ms: number, step = 100): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}

/** A relay-only connection whose pings have taught it a 1.9 s round trip: a 7.6 s deadline. */
async function slowLink() {
  const setup = await connected("relay", ["relay"]);
  const relay = setup.path("relay");
  relay.pongAfter = (deliver) => setup.clock.set(1_900, deliver);
  await wait(setup.clock, 7_000);
  expect(setup.client.linkEstimate()?.rttMs).toBe(1_900);
  return { ...setup, relay };
}

test("on a slow link a wake waits the link's own deadline: a 6 s pong keeps the socket", async () => {
  const h = await slowLink();
  h.relay.pongAfter = (deliver) => h.clock.set(6_000, deliver);
  const socket = h.relay.last;
  h.client.wake();
  await wait(h.clock, 7_000);
  expect(socket.closed).toBe(false);
  expect(h.client.state).toBe("ready");
});

test("on a slow link a silent socket is dropped at its scaled probe deadline", async () => {
  const h = await slowLink();
  h.relay.answers = false;
  const socket = h.relay.last;
  h.client.wake();
  // Four round trips of 1.9 s: the probe gives up at 7.6 s.
  await wait(h.clock, 7_500);
  expect(socket.closed).toBe(false);
  await wait(h.clock, 200);
  expect(socket.closed).toBe(true);
});

/** Let queued pongs land. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("200 wakes in a burst on a live socket send a few pings and keep it", async () => {
  const h = await ready(true);
  const before = h.pings();
  for (let wake = 0; wake < 200; wake++) h.connection.wake();
  await flush();
  // One ping now, and one when the 300 ms window ends for the wakes inside it.
  for (let step = 0; step < 10; step++) {
    h.advance(100);
    await flush();
  }
  expect(h.pings() - before).toBe(2);
  for (let step = 0; step < 10; step++) {
    h.advance(1_000);
    await flush();
  }
  expect(h.connection.state).toBe("ready");
});

test("the same burst on a dead socket drops it within the bound of the first wake", async () => {
  const h = await ready();
  for (let wake = 0; wake < 200; wake++) h.connection.wake();
  h.advance(4_900);
  expect(h.connection.state).toBe("ready");
  // One probe deadline (5 s, nothing measured) plus the 300 ms coalescing window.
  h.advance(400);
  expect(h.connection.state).toBe("reconnecting");
});

test("wakes spaced over 20 s on a dead socket still drop it within the bound of the first", async () => {
  const h = await ready();
  let elapsed = 0;
  while (elapsed < 20_000 && h.connection.state === "ready") {
    h.connection.wake();
    h.advance(250);
    elapsed += 250;
  }
  expect(h.connection.state).toBe("reconnecting");
  expect(elapsed).toBeLessThanOrEqual(5_300);
});

test("a wake after the socket died is not covered by an earlier wake's answered probe", async () => {
  const h = await ready();
  h.connection.wake();
  h.advance(50);
  // That wake's probe is answered; then the socket dies.
  h.pong();
  h.advance(150);
  h.connection.wake();
  // Covered by a ping of its own, sent within 300 ms: dropped within 300 ms + 5 s of the wake.
  h.advance(5_300);
  expect(h.connection.state).toBe("reconnecting");
});

test("answered probes never fill a cap that would ignore a later wake", async () => {
  const h = await ready();
  // Wakes at 0, 300, 600 and 900 ms, each answered 10 ms later.
  for (let wake = 0; wake < 4; wake++) {
    h.connection.wake();
    h.advance(10);
    h.pong();
    h.advance(wake < 3 ? 290 : 90);
  }
  // The socket has died; the wake at 1,000 ms must still be checked.
  h.connection.wake();
  h.advance(5_300);
  expect(h.connection.state).toBe("reconnecting");
});
