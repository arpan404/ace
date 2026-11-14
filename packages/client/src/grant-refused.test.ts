import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Connection } from "./connection.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";
import { WireCodec } from "./wire-codec.ts";

/** Let promise chains run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a refused grant refresh names its grant, so the next try fetches a fresh one", async () => {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  let events: TransportEvents | undefined;
  const sent: { type: string; requestId?: string; grant?: string }[] = [];
  const refused: (string | undefined)[] = [];
  let issued = 0;
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
      id: () => "refresh",
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
  connection.start();
  await settle();
  const frame = (message: object) => events?.message(JSON.stringify(message));
  frame({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0, grantTtlMs: 120_000 });
  // The refresh goes 60 s before the socket's grant runs out.
  await advance(60_000);
  const refresh = sent.find((message) => message.type === "account.grant.refresh");
  expect(refresh?.grant).toBe("refresh-1");
  frame({
    type: "account.grant.refresh.result",
    requestId: refresh?.requestId,
    result: { ok: false, code: "unauthorized", message: "Expired" },
  });
  expect(refused).toEqual(["refresh-1"]);
  // The keeper's retry fetches a new grant rather than offering the refused one.
  await advance(10_000);
  const retries = sent.filter((message) => message.type === "account.grant.refresh");
  expect(retries.at(-1)?.grant).toBe("refresh-2");
});
