import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** A connection on manual time that records every hello it sends. */
function recorded() {
  const timers: { delay: number; run: () => void; live: boolean }[] = [];
  const hellos: Record<string, unknown>[] = [];
  let events: TransportEvents | undefined;
  let now = 0;
  const link = new Connection(
    {
      deviceId: DeviceId.parse("report-device"),
      transport: () => ({
        open(next) {
          events = next;
          next.open();
        },
        send(text) {
          const message = JSON.parse(text) as Record<string, unknown>;
          if (message.type === "hello") hellos.push(message);
        },
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
      id: () => "id",
      monotonic: () => now,
    },
    new WireCodec(),
    { ...defaultLimits, retryBaseMs: 100, retryCapMs: 10_000, heartbeatMs: 70_000 },
    () => {},
    () => {},
    () => {},
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    link,
    hellos,
    at: (ms: number) => void (now = ms),
    settle,
    welcome: () =>
      events?.message(
        JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }),
      ),
    close: (code: number, reason?: string) => events?.close(code, reason),
    /** Run the reconnect the last drop scheduled. */
    retry: () => {
      const timer = timers.findLast((each) => each.live && each.delay <= 10_000);
      if (!timer) throw new Error("no reconnect scheduled");
      timer.live = false;
      timer.run();
    },
  };
}

test("the hello after a relayed drop tells the daemon how the last connection ended", async () => {
  const c = recorded();
  c.link.start();
  await c.settle();
  expect(c.hellos[0]).not.toHaveProperty("lastClose");
  c.at(1_000);
  c.welcome();
  c.at(4_000);
  c.close(1006, "receive failed (NSPOSIXErrorDomain 40)");
  c.at(9_000);
  c.retry();
  await c.settle();
  expect(c.hellos[1]?.lastClose).toEqual({
    code: 1006,
    reason: "receive failed (NSPOSIXErrorDomain 40)",
    wasReady: true,
    aliveMs: 3_000,
    downMs: 5_000,
    attempt: 0,
  });
});

test("a welcome settles the report: the next drop reports itself, not the one before", async () => {
  const c = recorded();
  c.link.start();
  await c.settle();
  c.welcome();
  c.close(1006, "first");
  c.retry();
  await c.settle();
  c.at(10_000);
  c.welcome();
  c.at(12_500);
  c.close(1000, "second");
  c.retry();
  await c.settle();
  expect(c.hellos[2]?.lastClose).toMatchObject({
    code: 1000,
    reason: "second",
    wasReady: true,
    aliveMs: 2_500,
  });
});
