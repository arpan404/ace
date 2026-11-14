import { expect, test } from "vitest";
import { LinkPipe, type LinkPipeOptions } from "./link-pipe.ts";
import { FlightCounter, countsSince, roundTrips } from "./link-flights.ts";
import { linkProfile, seededRandom } from "./link-profiles.ts";

const pipe = (options: Partial<LinkPipeOptions> = {}) =>
  new LinkPipe({
    bitsPerSecond: null,
    delayMs: 0,
    loss: 0,
    stallMs: 0,
    random: () => 1,
    ...options,
  });

test("a byte arrives one one-way delay after it was written on an unlimited link", () => {
  const link = pipe({ delayMs: 200 });
  expect(link.send(1_000, 10)).toEqual([{ start: 0, end: 10, at: 1_200 }]);
});

test("a chunk takes its size over the rate to cross, plus the delay", () => {
  // 400 kbit/s is 50 bytes per millisecond: 14,600 bytes take 292 ms on the wire.
  const link = pipe({ bitsPerSecond: 400_000, delayMs: 200 });
  const arrivals = link.send(0, 14_600);
  expect(arrivals.at(-1)?.end).toBe(14_600);
  expect(arrivals.at(-1)?.at).toBeCloseTo(492, 6);
  // The first segment is not held back for the rest of the chunk.
  expect(arrivals[0]?.at).toBeCloseTo(1460 / 50 + 200, 6);
});

test("a second write queues behind the first instead of sharing the rate", () => {
  const link = pipe({ bitsPerSecond: 400_000, delayMs: 0 });
  link.send(0, 5_000);
  const second = link.send(0, 5_000);
  expect(second.at(-1)?.at).toBeCloseTo(200, 6);
  expect(link.queued(0)).toBeCloseTo(10_000, 6);
  expect(link.queued(100)).toBeCloseTo(5_000, 6);
  expect(link.drainsTo(2_500)).toBeCloseTo(150, 6);
});

test("an idle link sends a later write at once rather than at its old busy time", () => {
  const link = pipe({ bitsPerSecond: 400_000, delayMs: 100 });
  link.send(0, 50);
  expect(link.send(10_000, 50)).toEqual([{ start: 0, end: 50, at: 10_101 }]);
});

test("a lost segment stalls it and every later segment, and nothing is dropped", () => {
  const draws = [0.5, 0.001, 0.5, 0.5];
  const link = pipe({
    bitsPerSecond: 8_000_000,
    delayMs: 50,
    loss: 0.02,
    stallMs: 600,
    random: () => draws.shift() ?? 0.5,
    segmentBytes: 1_000,
  });
  const arrivals = link.send(0, 4_000);
  // 1,000 bytes take 1 ms at 8 Mbit/s. The second segment is lost and arrives at 2 + 50 + 600;
  // the third and fourth were on time but TCP hands them over only after it.
  expect(arrivals).toEqual([
    { start: 0, end: 1_000, at: 51 },
    { start: 1_000, end: 4_000, at: 652 },
  ]);
  expect(link.stalls).toBe(1);
  expect(link.drainedAt).toBe(652);
});

test("the handshake hold delays a connection's first byte by a round trip", () => {
  const profile = linkProfile("3g-slow");
  const link = pipe({ bitsPerSecond: profile.upBitsPerSecond, delayMs: profile.rttMs / 2 });
  link.holdUntil(profile.rttMs);
  // 100 bytes at 200 kbit/s take 4 ms: SYN round trip, serialization, one-way delay.
  expect(link.send(0, 100).at(-1)?.at).toBeCloseTo(400 + 4 + 200, 6);
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
  const link = pipe({
    bitsPerSecond: 400_000,
    loss: 0.02,
    stallMs: 600,
    random: seededRandom(1),
  });
  link.send(0, 1460 * 10_000);
  expect(link.stalls).toBeGreaterThan(150);
  expect(link.stalls).toBeLessThan(250);
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
