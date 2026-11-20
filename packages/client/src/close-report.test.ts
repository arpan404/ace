import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Lets the credential promise and the hello it sends run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  return {
    link,
    hellos,
    at: (ms: number) => void (now = ms),
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
  await settle();
  expect(c.hellos[0]).not.toHaveProperty("lastClose");
  c.at(1_000);
  c.welcome();
  c.at(4_000);
  c.close(1006, "relay:emsgsize");
  c.at(9_000);
  c.retry();
  await settle();
  expect(c.hellos[1]?.lastClose).toEqual({
    code: 1006,
    cause: "emsgsize",
    wasReady: true,
    aliveMs: 3_000,
    downMs: 5_000,
    attempt: 0,
  });
});

test("a welcome settles the report: the next drop reports itself, not the one before", async () => {
  const c = recorded();
  c.link.start();
  await settle();
  c.welcome();
  c.close(1006, "relay:receive_failed");
  c.retry();
  await settle();
  c.at(10_000);
  c.welcome();
  c.at(12_500);
  c.close(1000, "Bye for now, recovery phrase alpha bravo");
  c.retry();
  await settle();
  expect(c.hellos[2]?.lastClose).toMatchObject({
    code: 1000,
    cause: "other",
    wasReady: true,
    aliveMs: 2_500,
  });
  expect(JSON.stringify(c.hellos[2])).not.toContain("recovery phrase");
});

test("a cause this build doesn't list is reported as other, and no close reason is ever sent as text", async () => {
  const c = recorded();
  c.link.start();
  await settle();
  c.welcome();
  c.close(4000, "relay:something-new");
  c.retry();
  await settle();
  expect(c.hellos[1]?.lastClose).toMatchObject({ code: 4000, cause: "other" });
  expect(JSON.stringify(c.hellos[1])).not.toContain("something-new");
});
