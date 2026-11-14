import { expect, test } from "vitest";
import { Bottleneck, type Arrival, type BottleneckOptions } from "./link-bottleneck.ts";
import { FlightCounter, countsSince, roundTrips } from "./link-flights.ts";
import { linkProfile, seededRandom } from "./link-profiles.ts";

const link = (options: Partial<BottleneckOptions> = {}) =>
  new Bottleneck({
    bitsPerSecond: null,
    delayMs: 0,
    loss: 0,
    stallMs: 0,
    random: () => 1,
    ...options,
  });

/** Pumps the link at every moment it can next send, as the shaper's timer does. */
function drain(bottleneck: Bottleneck, from = 0): Arrival[] {
  const arrivals = [...bottleneck.pump(from)];
  for (let wake = bottleneck.wakeAt(); wake !== undefined; wake = bottleneck.wakeAt())
    arrivals.push(...bottleneck.pump(wake));
  return arrivals;
}
const lastArrival = (arrivals: Arrival[], flow: number) =>
  Math.max(...arrivals.filter((arrival) => arrival.flow === flow).map((arrival) => arrival.at));
const bytesOf = (arrivals: Arrival[], flow: number) =>
  arrivals.filter((arrival) => arrival.flow === flow).reduce((sum, a) => sum + a.bytes.length, 0);

test("a byte arrives one one-way delay after it was written on an unlimited link", () => {
  const bottleneck = link({ delayMs: 200 });
  bottleneck.open(1);
  bottleneck.write(1, 1_000, new Uint8Array(10));
  expect(bottleneck.pump(1_000).map(({ flow, at }) => ({ flow, at }))).toEqual([
    { flow: 1, at: 1_200 },
  ]);
});

test("a transfer takes its size over the rate to cross, plus the delay", () => {
  // 400 kbit/s is 50 bytes per millisecond: 14,600 bytes take 292 ms on the wire.
  const bottleneck = link({ bitsPerSecond: 400_000, delayMs: 200 });
  bottleneck.open(1);
  bottleneck.write(1, 0, new Uint8Array(14_600));
  const arrivals = drain(bottleneck);
  expect(bytesOf(arrivals, 1)).toBe(14_600);
  expect(lastArrival(arrivals, 1)).toBeCloseTo(492, 6);
  // The first segment is not held back for the rest of the transfer.
  expect(arrivals[0]?.at).toBeCloseTo(1460 / 50 + 200, 6);
});

test("parallel transfers share one link: four together take four times as long as one", () => {
  const rate = { bitsPerSecond: 400_000, delayMs: 200 };
  const alone = link(rate);
  alone.open(1);
  alone.write(1, 0, new Uint8Array(20_000));
  const oneFinishes = lastArrival(drain(alone), 1);

  const shared = link(rate);
  for (const flow of [1, 2, 3, 4]) {
    shared.open(flow);
    shared.write(flow, 0, new Uint8Array(20_000));
  }
  const arrivals = drain(shared);
  const finishes = [1, 2, 3, 4].map((flow) => lastArrival(arrivals, flow));
  // 80,000 bytes at 50 bytes per millisecond, then the delay.
  expect(Math.max(...finishes)).toBeCloseTo(80_000 / 50 + 200, 0);
  expect(Math.max(...finishes)).toBeGreaterThan(3.9 * (oneFinishes - 200));
  // Turns are fair: every transfer finishes within a few segments of the others.
  expect(Math.max(...finishes) - Math.min(...finishes)).toBeLessThan((4 * 1460) / 50);
});

test("a connection that starts later gets its share at once instead of waiting its turn", () => {
  const bottleneck = link({ bitsPerSecond: 400_000 });
  bottleneck.open(1);
  bottleneck.open(2);
  bottleneck.write(1, 0, new Uint8Array(100_000));
  const early = bottleneck.pump(500);
  bottleneck.write(2, 500, new Uint8Array(1_460));
  const later = drain(bottleneck, 500);
  // One segment of flow 1 at most goes first; then the small one, not after 100 KB.
  expect(lastArrival(later, 2)).toBeLessThan(500 + (2 * 1460) / 50 + 1);
  expect(bytesOf([...early, ...later], 1)).toBe(100_000);
});

test("data written later is never overtaken by a decision made early", () => {
  const bottleneck = link({ bitsPerSecond: 400_000 });
  bottleneck.open(1);
  bottleneck.write(1, 0, new Uint8Array(1_460));
  // Nothing is decided for the future: the link is free again at about 29.2 ms.
  expect(bottleneck.pump(0)).toHaveLength(1);
  expect(bottleneck.wakeAt()).toBeUndefined();
  bottleneck.write(1, 10, new Uint8Array(1_460));
  expect(bottleneck.wakeAt()).toBeCloseTo(29.2, 6);
});

test("an idle link sends a later write at once rather than at its old busy time", () => {
  const bottleneck = link({ bitsPerSecond: 400_000, delayMs: 100 });
  bottleneck.open(1);
  bottleneck.write(1, 0, new Uint8Array(50));
  drain(bottleneck);
  bottleneck.write(1, 10_000, new Uint8Array(50));
  expect(bottleneck.pump(10_000).map((arrival) => arrival.at)).toEqual([10_101]);
});

test("a lost segment stalls its connection's later segments, not another connection's", () => {
  // Draws per segment in send order: flow 1's first is lost, the rest arrive on time.
  const draws = [0.001, 0.5, 0.5, 0.5];
  const bottleneck = link({
    bitsPerSecond: 8_000_000,
    delayMs: 50,
    loss: 0.02,
    stallMs: 600,
    random: () => draws.shift() ?? 0.5,
    segmentBytes: 1_000,
  });
  bottleneck.open(1);
  bottleneck.open(2);
  bottleneck.write(1, 0, new Uint8Array(2_000));
  bottleneck.write(2, 0, new Uint8Array(2_000));
  const arrivals = drain(bottleneck);
  // 1,000 bytes take 1 ms at 8 Mbit/s; segments alternate 1, 2, 1, 2.
  expect(arrivals.filter((a) => a.flow === 1).map((a) => a.at)).toEqual([651, 651]);
  expect(arrivals.filter((a) => a.flow === 2).map((a) => a.at)).toEqual([52, 54]);
  expect(bottleneck.stalls).toBe(1);
});

test("the handshake hold delays a connection's first byte by a round trip", () => {
  const profile = linkProfile("3g-slow");
  const bottleneck = link({ bitsPerSecond: profile.upBitsPerSecond, delayMs: profile.rttMs / 2 });
  bottleneck.open(1, profile.rttMs);
  bottleneck.write(1, 0, new Uint8Array(100));
  // 100 bytes at 200 kbit/s take 4 ms: SYN round trip, serialization, one-way delay.
  expect(lastArrival(drain(bottleneck), 1)).toBeCloseTo(400 + 4 + 200, 6);
});

test("what a connection has queued is its share of the bottleneck queue", () => {
  const bottleneck = link({ bitsPerSecond: 400_000 });
  bottleneck.open(1);
  bottleneck.write(1, 0, new Uint8Array(10_000));
  bottleneck.pump(0);
  expect(bottleneck.queued(1)).toBe(10_000 - 1_460);
  bottleneck.close(1);
  expect(bottleneck.queued(1)).toBe(0);
  expect(bottleneck.wakeAt()).toBeUndefined();
});

test("a profile's loss draws repeat for the same seed", () => {
  const first = seededRandom(7);
  const second = seededRandom(7);
  const a = Array.from({ length: 5 }, first);
  expect(Array.from({ length: 5 }, second)).toEqual(a);
  expect(a.every((value) => value >= 0 && value < 1)).toBe(true);
  expect(Array.from({ length: 5 }, seededRandom(8))).not.toEqual(a);
});

test("about the profile's fraction of segments stall over a long transfer", () => {
  const bottleneck = link({
    bitsPerSecond: 400_000,
    loss: 0.02,
    stallMs: 600,
    random: seededRandom(1),
  });
  bottleneck.open(1);
  bottleneck.write(1, 0, new Uint8Array(1460 * 10_000));
  drain(bottleneck);
  expect(bottleneck.stalls).toBeGreaterThan(150);
  expect(bottleneck.stalls).toBeLessThan(250);
});

test("a request and its answer count as one round trip after the handshake", () => {
  const counter = new FlightCounter();
  counter.opened(1);
  const start = counter.snapshot();
  counter.arrived(1, "up", 300);
  counter.arrived(1, "down", 1_000);
  counter.arrived(1, "down", 4_000);
  const first = counter.snapshot();
  expect(countsSince(start, first)).toMatchObject({ upFlights: 1, downFlights: 1 });
  expect(roundTrips(counter.snapshot())).toBe(2);
  counter.arrived(1, "up", 20);
  counter.arrived(1, "down", 30);
  expect(countsSince(first, counter.snapshot())).toEqual({
    connections: 0,
    upBytes: 20,
    downBytes: 30,
    upFlights: 1,
    downFlights: 1,
    stalls: 0,
  });
});

test("flights on one connection do not end flights on another", () => {
  const counter = new FlightCounter();
  counter.opened(1);
  counter.opened(2);
  counter.arrived(1, "down", 10);
  counter.arrived(2, "up", 10);
  counter.arrived(1, "down", 10);
  expect(counter.snapshot()).toMatchObject({ connections: 2, downFlights: 1, upFlights: 1 });
});
