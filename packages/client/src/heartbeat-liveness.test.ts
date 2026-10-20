import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type DiagnosticEvent, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

const beatMs = 1_000;

/** A ready connection on manual time whose daemon never answers pings unless told to. */
function link() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  let events: TransportEvents | undefined;
  const closes: number[] = [];
  const reports: DiagnosticEvent[] = [];
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("heartbeat-device"),
      transport: () => ({
        open(next) {
          events = next;
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
      report: (event) => reports.push(event),
    },
    new WireCodec(),
    { ...defaultLimits, heartbeatMs: beatMs, healthyMs: 60_000, requestMs: 60_000 },
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
  const frame = (message: object) => events?.message(JSON.stringify(message));
  const welcome = () => frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  return { connection, advance, frame, welcome, closes, reports };
}

const streamFrame = { type: "subscription.ready", subscriptionId: "sub-1", seq: 1 };

test("a socket that keeps receiving frames but whose pong is late is not dropped", async () => {
  const h = link();
  h.connection.start();
  await Promise.resolve();
  h.welcome();
  expect(h.connection.state).toBe("ready");
  // A busy stream: frames every 400 ms, and the pongs stuck behind them never arrive in time.
  for (let elapsed = 0; elapsed < 10 * beatMs; elapsed += 400) {
    h.advance(400);
    h.frame(streamFrame);
  }
  expect(h.connection.state).toBe("ready");
  expect(h.closes).toEqual([]);
});

test("a socket that receives nothing after a ping is dropped and the drop is reported", async () => {
  const h = link();
  h.connection.start();
  await Promise.resolve();
  h.welcome();
  h.frame(streamFrame);
  // One interval sends the ping; the next finds nothing arrived since.
  h.advance(2 * beatMs);
  expect(h.connection.state).toBe("reconnecting");
  expect(h.closes).toHaveLength(1);
  expect(h.reports).toContainEqual({
    event: "connection.closed",
    data: expect.objectContaining({
      code: 1006,
      heartbeatMissed: true,
      wasReady: true,
      next: "reconnecting",
      retryInMs: expect.any(Number),
    }),
  });
});

test("a reconnect after a drop is reported with how long the connection was down", async () => {
  const h = link();
  h.connection.start();
  await Promise.resolve();
  h.welcome();
  h.advance(2 * beatMs);
  expect(h.connection.state).toBe("reconnecting");
  const closedAt = 2 * beatMs;
  // Run the scheduled reconnect, then welcome the new socket.
  h.advance(defaultLimits.retryCapMs);
  await Promise.resolve();
  h.welcome();
  expect(h.connection.state).toBe("ready");
  const recovered = h.reports.find((report) => report.event === "connection.recovered");
  expect(recovered?.data?.attempts).toBe(1);
  expect(recovered?.data?.downMs).toBeGreaterThan(0);
  expect(recovered?.data?.downMs).toBeLessThanOrEqual(defaultLimits.retryCapMs + closedAt);
});
