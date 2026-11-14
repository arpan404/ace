import { DeviceId, type ServerMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

const exchangedTicket = "e".repeat(64);
const handedTicket = "c".repeat(64);

/** Let promise chains run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A connection on manual time whose sockets open at once, with a counted ticket exchange. */
function harness() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const sockets: { events: TransportEvents; hellos: Record<string, unknown>[] }[] = [];
  const delivered: ServerMessage[] = [];
  let exchanges = 0;
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("phone"),
      transport: () => {
        const socket = { events: undefined as unknown as TransportEvents, hellos: [] as never[] };
        return {
          open(events) {
            socket.events = events;
            sockets.push(socket);
            events.open();
          },
          send(text) {
            const message = JSON.parse(text);
            if (message.type === "hello") socket.hellos.push(message as never);
          },
          close() {},
        };
      },
      credential: async () => {
        exchanges++;
        return { ticket: exchangedTicket };
      },
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
    (message) => delivered.push(message),
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
  const socket = () => {
    const last = sockets.at(-1);
    if (!last) throw new Error("No socket");
    return last;
  };
  const frame = (message: object) => socket().events.message(JSON.stringify(message));
  const welcome = (ticket?: { ticket: string; ttlMs: number }) =>
    frame({
      type: "welcome",
      hostId: "host",
      protocolVersion: 1,
      headSeq: 0,
      ...(ticket ? { ticket } : {}),
    });
  const drop = async () => {
    socket().events.close(1006, "gone");
    await advance(defaultLimits.retryCapMs);
  };
  return {
    connection,
    sockets,
    delivered,
    socket,
    frame,
    welcome,
    drop,
    settle,
    advance,
    exchanges: () => exchanges,
  };
}

test("a reconnect says hello with the ticket the welcome handed over, skipping the exchange", async () => {
  const h = harness();
  h.connection.start();
  await h.settle();
  expect(h.socket().hellos[0]).toMatchObject({ ticket: exchangedTicket, nextTicket: true });
  h.welcome({ ticket: handedTicket, ttlMs: 60_000 });
  // The ticket stays inside the connection: nothing it delivers carries it.
  expect(JSON.stringify(h.delivered)).not.toContain(handedTicket);
  await h.drop();
  expect(h.exchanges()).toBe(1);
  expect(h.socket().hellos[0]).toMatchObject({ ticket: handedTicket });
});

test("a handed ticket is used once: the connect after it exchanges again", async () => {
  const h = harness();
  h.connection.start();
  await h.settle();
  h.welcome({ ticket: handedTicket, ttlMs: 60_000 });
  await h.drop();
  // An older daemon, or one out of quota, hands nothing over.
  h.welcome();
  await h.drop();
  expect(h.exchanges()).toBe(2);
  expect(h.socket().hellos[0]).toMatchObject({ ticket: exchangedTicket });
});

test("a handed ticket the daemon refuses is replaced by an exchange at once, not a stop", async () => {
  const h = harness();
  h.connection.start();
  await h.settle();
  h.welcome({ ticket: handedTicket, ttlMs: 60_000 });
  await h.drop();
  // The daemon restarted in between and no longer knows the ticket.
  h.frame({ type: "error", code: "unauthorized", message: "Valid hello required" });
  await h.settle();
  expect(h.connection.state).not.toBe("fatal");
  expect(h.socket().hellos[0]).toMatchObject({ ticket: exchangedTicket });
  h.welcome();
  expect(h.connection.state).toBe("ready");
  // An exchanged ticket refused the same way still stops: the device may be revoked.
  await h.drop();
  h.frame({ type: "error", code: "unauthorized", message: "Valid hello required" });
  await h.settle();
  expect(h.connection.state).toBe("fatal");
});

test("a handed ticket too close to running out is not offered", async () => {
  const h = harness();
  h.connection.start();
  await h.settle();
  h.welcome({ ticket: handedTicket, ttlMs: 20_000 });
  await h.advance(10_000);
  await h.drop();
  expect(h.socket().hellos[0]).toMatchObject({ ticket: exchangedTicket });
});
