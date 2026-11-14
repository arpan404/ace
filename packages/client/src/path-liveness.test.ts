import { expect, test } from "vitest";
import { connected, settle, type Clock } from "./path-switch.fixture.ts";

/** Let `ms` pass in `step` ms steps, letting pings and pongs (microtasks) run after each. */
async function wait(clock: Clock, ms: number, step = 500): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    clock.advance(Math.min(step, left));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  // A drop's reconnect runs through timers and promises: let it all land before asserting.
  await settle();
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

test("hidden keep-alives keep a mapping that expires after 30 s idle alive", async () => {
  const { clock, path } = await connected("relay", ["relay"], { visible: () => false });
  const relay = path("relay");
  // A carrier or NAT that forgets the mapping after 30 s without traffic.
  let lastPing = clock.now;
  relay.pongAfter = (deliver) => {
    if (clock.now - lastPing > 30_000) relay.answers = false;
    lastPing = clock.now;
    if (relay.answers) queueMicrotask(deliver);
  };
  await wait(clock, 120_000, 1_000);
  expect(relay.answers).toBe(true);
  expect(relay.sockets).toHaveLength(1);
});

test("a hidden window on a relay-only link finds a silently expired path within 31 s", async () => {
  const { clock, path } = await connected("relay", ["relay"], { visible: () => false });
  const relay = path("relay");
  // The first hidden ping goes at 25 s and is answered.
  await wait(clock, 25_500);
  // The mapping expires right after that pong; nothing comes back any more.
  relay.answers = false;
  // Next ping at 52 s (its 2 s deadline, then 25 s), missed twice: dropped by 56 s.
  await wait(clock, 29_000);
  expect(relay.sockets[0]?.closed).toBe(false);
  await wait(clock, 2_000);
  expect(relay.sockets[0]?.closed).toBe(true);
});
