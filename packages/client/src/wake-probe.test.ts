import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { connected, pass, settle } from "./path-switch.fixture.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Longer than the gap between a probe's answer and its 5 s deadline, so only the probe decides. */
const beatMs = 3_000;

/** A ready connection on manual time whose daemon answers pings only when told. */
async function ready() {
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
          if (JSON.parse(text).type === "ping") pings++;
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
  expect(h.pings()).toBe(2);
  // The old pong lands: it answers the old ping, not the probe.
  h.advance(100);
  h.pong();
  // The network changed under the socket: nothing more comes back. Dropped at the 5 s deadline.
  h.advance(4_800);
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
