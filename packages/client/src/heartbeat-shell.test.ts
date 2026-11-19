import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { Heartbeat } from "./heartbeat.ts";
import { defaultLimits, type Scheduler, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** A manual scheduler; `lateMs` delivers every timer that much after it is due. */
function manual(lateMs = 0) {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const scheduler: Scheduler = {
    set(delay, run) {
      const timer = { at: now + delay + lateMs, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  };
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
  return { scheduler, advance, now: () => now };
}

/** A heartbeat over a socket whose pongs come `pongMs` after each ping, or never. */
function beating(options: { lateMs?: number; pongMs?: number; clock?: () => number }) {
  const time = manual(options.lateMs);
  const pings: number[] = [];
  let missed = 0;
  let silent = false;
  const heartbeat = new Heartbeat(time.scheduler, 1_000, options.clock ?? time.now);
  heartbeat.start({
    ping: (answered) => {
      pings.push(time.now());
      const pongMs = options.pongMs;
      if (pongMs !== undefined && !silent)
        time.scheduler.set(pongMs, () => {
          heartbeat.heard();
          answered?.();
        });
      return true;
    },
    missed: () => void missed++,
  });
  /** The socket dies: no ping is answered from now on. */
  const silence = () => void (silent = true);
  return { heartbeat, pings, missed: () => missed, silence, ...time };
}

test("wakes every 100 ms on a dead socket, with the default clock, drop it within the bound", async () => {
  let events: TransportEvents | undefined;
  // No clock passed: the connection's own monotonic one, and real timers.
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("phone"),
      transport: () => ({
        open(next) {
          events = next;
          next.open();
        },
        send() {},
        close() {},
      }),
      credential: async () => "a".repeat(64),
      storage: { load: async () => null, save: async () => {} },
      scheduler: {
        set(delay, run) {
          const timer = setTimeout(run, delay);
          return () => clearTimeout(timer);
        },
      },
      random: () => 0.5,
      id: () => "id",
    },
    new WireCodec(),
    { ...defaultLimits, heartbeatMs: 60_000 },
    () => {},
    () => {},
    () => {},
  );
  connection.start();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  events?.message(
    JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }),
  );
  expect(connection.state).toBe("ready");
  // A 400 ms probe deadline keeps the test short: the bound is 300 ms plus that.
  connection.probeDeadline(() => 400);
  const first = performance.now();
  let droppedAt: number | undefined;
  while (performance.now() - first < 2_000) {
    if (connection.state !== "ready") {
      droppedAt = performance.now();
      break;
    }
    connection.wake();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  connection.stop();
  expect(droppedAt).toBeDefined();
  // 300 ms + 400 ms, and the 100 ms between checks.
  expect((droppedAt ?? Infinity) - first).toBeLessThanOrEqual(800 + 150);
});

test("a clock that jumps backwards delays neither the owed ping nor any deadline", () => {
  // The source reads wall time: 10 s ahead of the scheduler, until it is set back to zero.
  let skew = 10_000;
  let time: { now(): number } | undefined;
  const h = beating({ pongMs: 50, clock: () => (time?.now() ?? 0) + skew });
  time = h;
  // A probe at wall time 10 s, answered 50 ms later.
  h.heartbeat.probe(5_000);
  h.advance(100);
  expect(h.pings).toHaveLength(1);
  // The device's time is set back to zero, and the socket dies.
  skew = -h.now();
  h.silence();
  // A wake right after: its ping goes within 300 ms of it (the jump reads as no time passing).
  h.heartbeat.probe(5_000);
  h.advance(300);
  expect(h.pings).toHaveLength(2);
  const sentAt = h.pings[1] ?? 0;
  // Dropped 5 s after that ping, in real time.
  h.advance(sentAt + 4_900 - h.now());
  expect(h.missed()).toBe(0);
  h.advance(200);
  expect(h.missed()).toBe(1);
});

test("timers that fire 2 s late still report a dead socket", () => {
  const h = beating({ lateMs: 2_000 });
  h.heartbeat.probe(5_000);
  h.advance(7_000);
  expect(h.missed()).toBe(1);
});

test("timers that fire 2 s late never drop a socket that answers", () => {
  const h = beating({ lateMs: 2_000, pongMs: 50 });
  for (let step = 0; step < 30; step++) {
    if (step % 7 === 0) h.heartbeat.probe(5_000);
    h.advance(2_000);
  }
  expect(h.missed()).toBe(0);
});

test("incoming frames do not move the regular heartbeat's cadence", () => {
  const h = beating({ pongMs: 20 });
  for (let step = 0; step < 50; step++) {
    h.advance(130);
    h.heartbeat.heard();
  }
  expect(h.pings.slice(0, 6)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000, 6_000]);
});
