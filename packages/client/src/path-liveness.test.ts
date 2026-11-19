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

test("a hidden window on a relay-only link finds a silently expired path within 29 s", async () => {
  const { clock, path } = await connected("relay", ["relay"], { visible: () => false });
  const relay = path("relay");
  // The first hidden ping goes at 25 s and is answered.
  await wait(clock, 25_500);
  // The mapping expires right after that pong; nothing comes back any more.
  relay.answers = false;
  // Next ping at 50 s, 25 s after the last; missed at 52 s, pinged again, missed at 54 s.
  await wait(clock, 26_000);
  expect(relay.sockets[0]?.closed).toBe(false);
  await wait(clock, 3_000);
  expect(relay.sockets[0]?.closed).toBe(true);
});

/** The longest gap between consecutive pings on the wire, from their send times. */
const longestGap = (times: readonly number[]) =>
  Math.max(...times.slice(1).map((at, index) => at - (times[index] ?? 0)));

for (const [name, visible, intervalMs] of [
  ["hidden", false, 25_000],
  ["visible", true, 5_000],
] as const)
  test(`${name} pings stay ${intervalMs / 1000} s apart from ping to ping on a slow link`, async () => {
    const { clock, path } = await connected("relay", ["relay"], { visible: () => visible });
    const relay = path("relay");
    // A 2.5 s round trip: the pong deadline grows to its 10 s cap.
    const sent: number[] = [];
    relay.pongAfter = (deliver) => {
      sent.push(clock.now);
      clock.set(2_500, deliver);
    };
    await wait(clock, 200_000);
    expect(sent.length).toBeGreaterThan(5);
    expect(longestGap(sent)).toBeLessThanOrEqual(intervalMs);
    // Every pong came back: the path was never dropped.
    expect(relay.sockets).toHaveLength(1);
  });

test("a hidden mapping that expires after 30 s idle survives a slow link's pongs", async () => {
  const { clock, path } = await connected("relay", ["relay"], { visible: () => false });
  const relay = path("relay");
  let lastPing = clock.now;
  relay.pongAfter = (deliver) => {
    if (clock.now - lastPing > 30_000) relay.answers = false;
    lastPing = clock.now;
    if (relay.answers) clock.set(2_500, deliver);
  };
  await wait(clock, 200_000);
  expect(relay.answers).toBe(true);
  expect(relay.sockets).toHaveLength(1);
});

test("a wall clock set back during a ping changes neither the round trip nor the probe deadline", async () => {
  // The wall clock starts with the manual time and is set back by 10 s at one moment.
  let skew = 0;
  let manual: Clock | undefined;
  const { clock, client, path } = await connected("relay", ["relay"], {
    wall: () => (manual?.now ?? 0) + skew,
  });
  manual = clock;
  const relay = path("relay");
  relay.pongAfter = (deliver) => clock.set(1_900, deliver);
  await wait(clock, 7_000, 100);
  expect(client.linkEstimate()?.rttMs).toBe(1_900);
  // On the next ping, the device's time is set back by 10 s just before its pong lands.
  let jumped = false;
  relay.pongAfter = (deliver) =>
    clock.set(1_900, () => {
      if (!jumped) skew -= 10_000;
      jumped = true;
      deliver();
    });
  await wait(clock, 7_000, 100);
  expect(jumped).toBe(true);
  expect(client.linkEstimate()?.rttMs).toBe(1_900);
  // The probe deadline is still four round trips: a silent socket is dropped at 7.6 s.
  relay.answers = false;
  const socket = relay.last;
  client.wake();
  await wait(clock, 7_500, 100);
  expect(socket.closed).toBe(false);
  await wait(clock, 200, 100);
  expect(socket.closed).toBe(true);
});
