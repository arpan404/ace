import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

// Long enough that only a wake, never the regular beat, can notice a dead socket in these tests.
const beatMs = 60_000;

/** A connection on manual time; every socket it opens is kept so a reconnect shows as a new one. */
function link() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const sockets: TransportEvents[] = [];
  const closes: number[] = [];
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("wake-device"),
      transport: () => ({
        open(next) {
          sockets.push(next);
          next.open();
        },
        send() {},
        close() {
          closes.push(now);
        },
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
    },
    new WireCodec(),
    {
      ...defaultLimits,
      heartbeatMs: beatMs,
      healthyMs: 600_000,
      requestMs: 600_000,
      retryBaseMs: 20_000,
      retryCapMs: 120_000,
    },
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
  const frame = (message: object) => sockets.at(-1)?.message(JSON.stringify(message));
  const ready = async () => {
    await Promise.resolve();
    frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
    expect(connection.state).toBe("ready");
  };
  return { connection, sockets, closes, advance, frame, ready };
}

test("a woken app replaces a socket that went silent while suspended within seconds", async () => {
  const h = link();
  h.connection.start();
  await h.ready();
  h.connection.wake();
  h.advance(5_000);
  expect(h.connection.state).toBe("reconnecting");
  expect(h.closes).toHaveLength(1);
});

test("a woken app keeps a socket that answers, and its regular heartbeat carries on", async () => {
  const h = link();
  h.connection.start();
  await h.ready();
  h.connection.wake();
  h.advance(1_000);
  h.frame({ type: "pong" });
  h.advance(10_000);
  expect(h.connection.state).toBe("ready");
  expect(h.closes).toEqual([]);
  // The beat resumed: a daemon that now stays silent is still caught by it.
  h.advance(2 * beatMs);
  expect(h.connection.state).toBe("reconnecting");
});

test("a woken app reconnects at once instead of waiting out its backoff", async () => {
  const h = link();
  h.connection.start();
  await h.ready();
  h.sockets.at(-1)?.close(1006);
  expect(h.connection.state).toBe("reconnecting");
  expect(h.sockets).toHaveLength(1);
  h.connection.wake();
  await Promise.resolve();
  expect(h.sockets).toHaveLength(2);
});

test("waking a stopped connection opens nothing", async () => {
  const h = link();
  h.connection.start();
  await h.ready();
  h.connection.stop();
  h.connection.wake();
  h.advance(10_000);
  expect(h.sockets).toHaveLength(1);
  expect(h.connection.state).toBe("offline");
});
