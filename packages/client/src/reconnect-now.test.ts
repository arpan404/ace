import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";

/**
 * A client on manual time and a manual clock, whose daemon can be refused, accepted or dropped.
 * Every socket the client opens is recorded, so a reconnect is visible as a new socket.
 */
function harness() {
  let clock = 1_000_000;
  const timers: { delay: number; run: () => void; live: boolean }[] = [];
  const sockets: TransportEvents[] = [];
  const limits = {
    ...defaultLimits,
    retryBaseMs: 1_000,
    retryCapMs: 60_000,
    requestMs: 600_000,
    heartbeatMs: 700_000,
    healthyMs: 500_000,
  };
  const client = new Client({
    deviceId: DeviceId.parse("retry-now-device"),
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
        const timer = { delay, run, live: true };
        timers.push(timer);
        return () => void (timer.live = false);
      },
    },
    random: () => 0.5,
    id: () => crypto.randomUUID(),
    now: () => clock,
    limits,
  });
  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("no socket opened");
    return socket;
  };
  /** The daemon refuses the newest socket. Returns the backoff the client scheduled for it. */
  const refuse = () => {
    latest().close(1006);
    const retry = timers.findLast((timer) => timer.live && timer.delay <= limits.retryCapMs);
    if (!retry) throw new Error("no reconnect scheduled");
    return retry;
  };
  const welcome = () =>
    latest().message(
      JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }),
    );
  const advance = (ms: number) => {
    clock += ms;
  };
  return { client, sockets, refuse, welcome, advance, now: () => clock };
}

test("Retry now reconnects at once instead of waiting out the backoff", async () => {
  const { client, sockets, refuse } = harness();
  await client.start();
  const first = refuse();
  expect(client.state).toBe("reconnecting");
  expect(sockets).toHaveLength(1);

  client.reconnectNow();
  expect(sockets).toHaveLength(2);
  // The skipped timer no longer reconnects on its own.
  expect(first.live).toBe(false);
});

test("a retry that fails after Retry now still backs off further, not from the start", async () => {
  const { client, refuse } = harness();
  await client.start();
  const first = refuse().delay;
  client.reconnectNow();
  const second = refuse().delay;
  expect(second).toBeGreaterThan(first);
});

test("connectionInfo says when the scheduled retry runs", async () => {
  const { client, refuse, now, advance } = harness();
  await client.start();
  advance(250);
  const retry = refuse();
  const info = client.connectionInfo().getSnapshot();
  expect(info).toMatchObject({ state: "reconnecting", attempt: 1, since: now() });
  expect(info.nextRetryAt).toBe(now() + retry.delay);
});

test("connectionInfo subscribers hear about the retry schedule and the return to ready", async () => {
  const { client, refuse, welcome, advance, now } = harness();
  await client.start();
  const info = client.connectionInfo();
  const seen: (number | undefined)[] = [];
  const stop = info.subscribe(() => seen.push(info.getSnapshot().nextRetryAt));
  const retry = refuse();
  expect(seen.at(-1)).toBe(now() + retry.delay);

  client.reconnectNow();
  advance(40);
  welcome();
  const ready = info.getSnapshot();
  expect(ready).toMatchObject({ state: "ready", lastReadyAt: now(), since: now() });
  expect(ready.nextRetryAt).toBeUndefined();
  expect(seen.at(-1)).toBeUndefined();
  stop();
});

test("Retry now does nothing while connected, or once the daemon has refused for good", async () => {
  const { client, sockets, welcome } = harness();
  await client.start();
  welcome();
  client.reconnectNow();
  expect(sockets).toHaveLength(1);
  expect(client.state).toBe("ready");

  // 4001: the daemon rejected the token. Retrying can't help, so Retry now doesn't try.
  sockets[0]?.close(4001);
  expect(client.state).toBe("fatal");
  client.reconnectNow();
  expect(sockets).toHaveLength(1);
});

test("Retry now does not abandon an attempt that is already under way", async () => {
  const { client, sockets } = harness();
  await client.start();
  expect(client.state).toBe("connecting");
  client.reconnectNow();
  expect(sockets).toHaveLength(1);
});
