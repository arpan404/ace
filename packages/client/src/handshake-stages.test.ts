import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { connected, pass } from "./path-switch.fixture.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Let promise chains run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A connection on manual time whose sockets open only when told. */
function harness() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const sockets: TransportEvents[] = [];
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("device"),
      transport: () => ({
        open(events) {
          sockets.push(events);
        },
        send() {},
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
    },
    new WireCodec(),
    defaultLimits,
    () => {},
    () => {},
    () => {},
  );
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
      await settle();
    }
    now = until;
  };
  const last = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("No socket");
    return socket;
  };
  const frame = (message: object) => last().message(JSON.stringify(message));
  return { connection, sockets, last, frame, advance, settle };
}

test("a dial that never opens is retried after 30 s, not 2 minutes", async () => {
  const h = harness();
  h.connection.start();
  await h.advance(29_000);
  expect(h.connection.state).toBe("connecting");
  await h.advance(1_000);
  expect(h.connection.state).toBe("reconnecting");
  expect(h.connection.info().lastClose?.reason).toBe("Handshake timed out");
});

test("a daemon that said it is starting gets the whole 2 minutes for its welcome", async () => {
  const h = harness();
  h.connection.start();
  h.last().open();
  await h.settle();
  h.frame({ type: "starting" });
  await h.advance(100_000);
  expect(h.connection.state).toBe("starting");
  h.frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  expect(h.connection.state).toBe("ready");
});

test("after a slow open, the next dial waits four times as long before giving up", async () => {
  const h = harness();
  h.connection.start();
  // This link takes 20 s to open a socket.
  await h.advance(20_000);
  h.last().open();
  await h.settle();
  h.frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 });
  h.last().close(1006, "gone");
  while (h.sockets.length < 2) await h.advance(100);
  // The redial gets 80 s, not 30 s.
  await h.advance(70_000);
  expect(h.sockets).toHaveLength(2);
  await h.advance(15_000);
  expect(h.sockets).toHaveLength(3);
});

test("a socket the path manager pings carries no second ping loop", async () => {
  const { clock, path } = await connected("relay", ["relay"]);
  const relay = path("relay");
  const pings: number[] = [];
  relay.pongAfter = (deliver) => {
    pings.push(clock.now);
    queueMicrotask(deliver);
  };
  await pass(clock, 70_000);
  // Only the manager's 5 s loop: the connection's own 15 s beat would land between its pings.
  expect(pings.length).toBeGreaterThan(5);
  const gaps = pings.slice(1).map((at, index) => at - (pings[index] ?? 0));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5_000);
});
