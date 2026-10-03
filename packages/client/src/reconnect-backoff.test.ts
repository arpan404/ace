import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** A connection on manual time whose daemon welcomes it and can drop it at will. */
function flapping() {
  const timers: { delay: number; run: () => void; live: boolean }[] = [];
  let events: TransportEvents | undefined;
  const limits = {
    ...defaultLimits,
    retryBaseMs: 100,
    retryCapMs: 10_000,
    requestMs: 60_000,
    heartbeatMs: 70_000,
    healthyMs: 50_000,
  };
  const link = new Connection(
    {
      deviceId: DeviceId.parse("backoff-device"),
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
          const timer = { delay, run, live: true };
          timers.push(timer);
          return () => void (timer.live = false);
        },
      },
      random: () => 0.999,
      id: () => "id",
    },
    new WireCodec(),
    limits,
    () => {},
    () => {},
    () => {},
  );
  const welcome = () =>
    events?.message(
      JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }),
    );
  /** Drop the socket and run the reconnect it schedules; returns that reconnect's delay. */
  const drop = () => {
    events?.close(1006);
    const retry = timers.findLast((timer) => timer.live && timer.delay < limits.retryCapMs + 1);
    if (!retry) throw new Error("no reconnect scheduled");
    retry.live = false;
    retry.run();
    return retry.delay;
  };
  const stayUp = () => {
    const healthy = timers.findLast((timer) => timer.live && timer.delay === limits.healthyMs);
    if (!healthy) throw new Error("no healthy timer");
    healthy.live = false;
    healthy.run();
  };
  return { link, welcome, drop, stayUp };
}

test("a daemon that accepts and drops at once keeps being retried later, not at the base delay", () => {
  const { link, welcome, drop } = flapping();
  link.start();
  const delays: number[] = [];
  for (let n = 0; n < 5; n++) {
    welcome();
    delays.push(drop());
  }
  for (let n = 1; n < delays.length; n++)
    expect(delays[n]).toBeGreaterThan(delays[n - 1] ?? Infinity);
});

test("after a connection stays up for a while, the next drop is retried at the base delay again", () => {
  const { link, welcome, drop, stayUp } = flapping();
  link.start();
  welcome();
  const first = drop();
  for (let n = 0; n < 4; n++) {
    welcome();
    drop();
  }
  welcome();
  stayUp();
  expect(drop()).toBe(first);
});
