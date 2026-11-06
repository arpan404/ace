import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A client on manual timers whose credential the test can change, as a new pairing of the same
 * install does. Every socket and every hello it sends is recorded.
 */
function harness() {
  const timers: { delay: number; run: () => void; live: boolean }[] = [];
  const sockets: TransportEvents[] = [];
  const hellos: unknown[] = [];
  let token = "a".repeat(64);
  const client = new Client({
    deviceId: DeviceId.parse("replaced-device"),
    transport: () => ({
      open(events) {
        sockets.push(events);
        events.open();
      },
      send(frame) {
        if (typeof frame !== "string") return;
        const message: unknown = JSON.parse(frame);
        if (typeof message === "object" && message && "type" in message && message.type === "hello")
          hellos.push(message);
      },
      close() {},
    }),
    credential: async () => token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const timer = { delay, run, live: true };
        timers.push(timer);
        return () => void (timer.live = false);
      },
    },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
    now: () => 1_000_000,
    limits: { ...defaultLimits, heartbeatMs: 700_000, healthyMs: 500_000, requestMs: 600_000 },
  });
  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  };
  const welcome = () =>
    latest().message(
      JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }),
    );
  const retry = () => {
    const timer = timers.findLast((entry) => entry.live && entry.delay <= defaultLimits.retryCapMs);
    if (!timer) throw new Error("no reconnect scheduled");
    timer.live = false;
    timer.run();
  };
  return {
    client,
    sockets,
    hellos,
    latest,
    welcome,
    retry,
    repair: (next: string) => void (token = next),
  };
}

test("a socket closed because the install paired again reconnects with the new credential", async () => {
  const { client, sockets, hellos, latest, welcome, retry, repair } = harness();
  await client.start();
  await settle();
  welcome();
  expect(hellos.at(-1)).toMatchObject({ token: "a".repeat(64) });

  repair("b".repeat(64));
  latest().close(4001, "Credential replaced");
  expect(client.state).toBe("reconnecting");
  retry();
  await settle();
  expect(sockets).toHaveLength(2);
  expect(hellos.at(-1)).toMatchObject({ token: "b".repeat(64) });
  welcome();
  expect(client.state).toBe("ready");
});

test("a client still holding the replaced credential stops at the daemon's plain refusal", async () => {
  const { client, sockets, latest, welcome, retry } = harness();
  await client.start();
  await settle();
  welcome();
  latest().close(4001, "Credential replaced");
  retry();
  await settle();
  // The daemon refuses the old credential with a plain 4001: final, no loop.
  latest().close(4001, "unauthorized");
  expect(client.state).toBe("fatal");
  client.reconnectNow();
  expect(sockets).toHaveLength(2);
});
