import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Let promise chains run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A welcomed account connection on manual time whose daemon answers pings. */
async function welcomed() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  let events: TransportEvents | undefined;
  const sent: { type: string; requestId?: string; grant?: string }[] = [];
  const refused: (string | undefined)[] = [];
  let issued = 0;
  let ids = 0;
  const connection = new Connection(
    {
      deviceId: DeviceId.parse("browser"),
      transport: () => ({
        open(next) {
          events = next;
          next.open();
        },
        send(text) {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.type === "ping")
            queueMicrotask(() => events?.message(JSON.stringify({ type: "pong" })));
        },
        close() {},
      }),
      credential: async () => ({ grant: "hello-grant" }),
      grant: async () => `refresh-${++issued}`,
      grantRefused: (grant) => {
        refused.push(grant);
        return true;
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
      id: () => `refresh-id-${++ids}`,
      now: () => now,
      // Durations run on the monotonic clock: this test's manual time.
      monotonic: () => now,
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
  connection.start();
  await settle();
  const frame = (message: object) => events?.message(JSON.stringify(message));
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0, grantTtlMs: 120_000 });
  const refreshes = () => sent.filter((message) => message.type === "account.grant.refresh");
  const refuse = (requestId: string | undefined) =>
    frame({
      type: "account.grant.refresh.result",
      requestId,
      result: { ok: false, code: "unauthorized", message: "Expired" },
    });
  return { advance, refused, refreshes, refuse };
}

test("a refused grant refresh names its grant, so the next try fetches a fresh one", async () => {
  const h = await welcomed();
  // The refresh goes 60 s before the socket's grant runs out.
  await h.advance(60_000);
  const [refresh] = h.refreshes();
  expect(refresh?.grant).toBe("refresh-1");
  h.refuse(refresh?.requestId);
  expect(h.refused).toEqual(["refresh-1"]);
  // The keeper's retry fetches a new grant rather than offering the refused one.
  await h.advance(10_000);
  expect(h.refreshes().at(-1)?.grant).toBe("refresh-2");
});

test("a late refusal of an earlier refresh names nothing, and never the newer grant", async () => {
  const h = await welcomed();
  await h.advance(60_000);
  // Refresh A goes unanswered; 10 s later the keeper sends refresh B with a newer grant.
  await h.advance(10_000);
  const [first, second] = h.refreshes();
  expect(second?.grant).toBe("refresh-2");
  // A's refusal arrives late: the keeper ignores it, and so does the grant cache.
  h.refuse(first?.requestId);
  expect(h.refused).toEqual([]);
  h.refuse(second?.requestId);
  expect(h.refused).toEqual(["refresh-2"]);
});
