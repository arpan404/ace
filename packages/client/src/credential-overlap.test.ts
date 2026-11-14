import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { racingTransport, type MachineRoute } from "./path-race.ts";
import { ClientError, defaultLimits, type Transport, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A connection whose socket opens only when told, and whose credential is a gated exchange. */
function dialing(credential: () => Promise<{ ticket: string }>) {
  let events: TransportEvents | undefined;
  const sent: string[] = [];
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("device"),
      transport: () => ({
        open(next) {
          events = next;
        },
        send(text) {
          sent.push(text);
        },
        close() {},
      }),
      credential,
      storage: { load: async () => null, save: async () => {} },
      scheduler: { set: () => () => {} },
      random: () => 0.5,
      id: () => "id",
    },
    new WireCodec(),
    defaultLimits,
    () => {},
    () => {},
    () => {},
  );
  return { connection, sent, open: () => events?.open() };
}

test("the ticket exchange starts while the socket dials, and its ticket goes in the hello", async () => {
  let asked = 0;
  let answer: (value: { ticket: string }) => void = () => {};
  const h = dialing(() => {
    asked++;
    return new Promise((resolve) => (answer = resolve));
  });
  h.connection.start();
  await settle();
  // The socket has not opened, and the exchange is already under way.
  expect(asked).toBe(1);
  h.open();
  await settle();
  expect(h.sent).toEqual([]);
  answer({ ticket: "t".repeat(64) });
  await settle();
  expect(asked).toBe(1);
  expect(JSON.parse(h.sent[0] ?? "{}")).toMatchObject({ type: "hello", ticket: "t".repeat(64) });
});

test("a refused exchange still stops the connection once the socket opens", async () => {
  const h = dialing(async () => {
    throw new ClientError("auth");
  });
  h.connection.start();
  await settle();
  expect(h.connection.state).toBe("connecting");
  h.open();
  await settle();
  expect(h.connection.state).toBe("fatal");
  expect(h.connection.error?.code).toBe("auth");
});

test("a raced path asks for its credential when it starts dialing, not when it wins", async () => {
  const asked: string[] = [];
  const opens = new Map<string, TransportEvents>();
  const route = (key: string): MachineRoute => ({
    path: { key, kind: "lan" },
    transport: (): Transport => ({
      open(events) {
        opens.set(key, events);
      },
      send() {},
      close() {},
    }),
    credential: async () => {
      asked.push(key);
      return { ticket: key.repeat(64).slice(0, 64) };
    },
  });
  const race = racingTransport({
    routes: [route("a")],
    scheduler: { set: () => () => {} },
    won: () => {},
    failed: () => {},
  });
  let opened = false;
  race.open({ open: () => (opened = true), close: () => {}, message: () => {} });
  await settle();
  expect(opened).toBe(false);
  expect(asked).toEqual(["a"]);
  opens.get("a")?.open();
  await expect(race.credential?.()).resolves.toEqual({ ticket: "a".repeat(64) });
  // The winner's credential is the one fetched while it dialed: not asked for again.
  expect(asked).toEqual(["a"]);
});
