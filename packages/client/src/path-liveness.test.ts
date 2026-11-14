import { expect, test } from "vitest";
import { connected, settle, type Clock } from "./path-switch.fixture.ts";

/** Let `ms` pass in `step` ms steps, letting promise chains run after each. */
async function wait(clock: Clock, ms: number, step = 500): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left));
    await settle();
  }
}

test("one pong 3 s late on a relay-only link does not drop the path", async () => {
  const { clock, client, multipath, path } = await connected("relay", ["relay"]);
  const relay = path("relay");
  relay.pongAfter = (deliver) => clock.set(3_000, deliver);
  // The first ping goes at 5 s; its pong lands at 8 s, past the old 2 s deadline.
  await wait(clock, 12_000);
  expect(client.state).toBe("ready");
  expect(multipath.active?.kind).toBe("relay");
  expect(relay.sockets).toHaveLength(1);
  // The slow round trip is learned: later pongs as late are on time.
  await wait(clock, 10_000);
  expect(relay.sockets).toHaveLength(1);
  expect(multipath.linkEstimate()?.rttMs).toBeGreaterThanOrEqual(2_900);
});

test("a relay-only path that stops answering is dropped on its second missed pong", async () => {
  const { clock, path } = await connected("relay", ["relay"]);
  const relay = path("relay");
  relay.answers = false;
  // Ping at 5 s, first miss at 7 s, ping again at once, second miss at 9 s: a new socket.
  await wait(clock, 8_500);
  expect(relay.sockets).toHaveLength(1);
  await wait(clock, 1_000);
  expect(relay.sockets[0]?.closed).toBe(true);
});

test("with a warm standby, one missed pong fails over at once", async () => {
  const { clock, client, multipath, path } = await connected("lan", ["lan", "relay"]);
  path("lan").answers = false;
  await wait(clock, 7_500);
  expect(multipath.active?.kind).toBe("relay");
  expect(client.state).toBe("ready");
});

test("the link estimate is the active path's smoothed round trip and when it was measured", async () => {
  const { clock, client, path } = await connected("relay", ["relay"]);
  expect(client.linkEstimate()).toBeUndefined();
  path("relay").pongAfter = (deliver) => clock.set(400, deliver);
  await wait(clock, 5_400, 200);
  expect(client.linkEstimate()).toEqual({ rttMs: 400, at: 5_400, path: "relay" });
});
