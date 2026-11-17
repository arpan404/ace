import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";

/** A client on a scripted socket: the test plays the daemon's frames and drops the socket. */
async function connected() {
  let socket: TransportEvents | undefined;
  const timers: { run(): void; live: boolean }[] = [];
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: () => ({
      open(events) {
        socket = events;
      },
      send() {},
      close() {},
    }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(_delayMs, run) {
        const timer = { run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    },
    random: () => 0.5,
    id: () => `id-${++id}`,
    limits: defaultLimits,
  });
  await client.start();
  const welcome = (extra: object = {}) =>
    socket?.message(
      JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0, ...extra }),
    );
  const reconnect = () => {
    const before = timers.length;
    socket?.close(1006);
    for (const timer of timers.slice(before)) if (timer.live) timer.run();
  };
  return { client, welcome, reconnect };
}

test("a client reads the daemon's release line from its welcome, and forgets it with the socket", async () => {
  const h = await connected();
  const line = h.client.releaseLine();
  h.welcome({ releaseLine: "beta" });
  expect(line.getSnapshot()).toBe("beta");
  h.reconnect();
  expect(line.getSnapshot()).toBeUndefined();
  // A daemon from before release lines says nothing, so nothing is claimed.
  h.welcome();
  expect(line.getSnapshot()).toBeUndefined();
});
