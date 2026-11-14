import { describe, expect, it } from "vitest";
import {
  seededRandom,
  SimpleLink,
  TcpLeg,
  threeGLink,
  threeGProfiles,
  type LegSpec,
  type Random,
} from "./link-model.ts";

/** Each segment draws twice, jitter then loss; this loses the listed segments (0-based). */
function losing(...lost: number[]): Random {
  let draw = 0;
  return () => {
    const segment = Math.floor(draw / 2);
    const isLossDraw = draw % 2 === 1;
    draw++;
    return isLossDraw && lost.includes(segment) ? 0 : 0.999;
  };
}

const never: Random = () => 0.999;
/** Fast enough that only the window and the delay matter. */
const fast: LegSpec = { kbps: 1_000_000, rttMs: 100, jitterMs: 0, loss: 0.5, mss: 1000 };

/** 400 kbit/s, 50 bytes per ms, with a 50 KB burst at 1 s and every 10 s after. */
const shared = (): TcpLeg =>
  new TcpLeg(
    {
      kbps: 400,
      rttMs: 1,
      jitterMs: 0,
      loss: 0,
      mss: 1000,
      initialWindow: 1000,
      competing: { bytes: 50_000, everyMs: 10_000, firstAfterMs: 1_000 },
    },
    never,
    0,
  );

/** Sends 20 KB chunks every 100 ms for ten seconds and returns when each arrived. */
function stream(seed: number, name: keyof typeof threeGProfiles): number[] {
  const { down } = threeGLink(threeGProfiles[name], seededRandom(seed), 0);
  return Array.from({ length: 100 }, (_, index) => down.send(20_000, index * 100));
}

describe("a TCP leg", () => {
  it.each([
    { segments: 10, rounds: 1 },
    { segments: 30, rounds: 2 },
    { segments: 70, rounds: 3 },
    { segments: 71, rounds: 4 },
    { segments: 150, rounds: 4 },
  ])("slow start delivers $segments segments in $rounds round trips", ({ segments, rounds }) => {
    const leg = new TcpLeg(fast, never, 0);
    const arrival = leg.send(segments * 1000, 0);
    // The last round starts (rounds - 1) round trips in, then takes half a round trip to land.
    expect(arrival).toBeGreaterThanOrEqual((rounds - 1) * 100 + 50);
    expect(arrival).toBeLessThan((rounds - 1) * 100 + 51);
  });

  it("sends no faster than its rate once the window is open", () => {
    const leg = new TcpLeg(
      { kbps: 400, rttMs: 1, jitterMs: 0, loss: 0, mss: 1000, initialWindow: 1000 },
      never,
      0,
    );
    // 400 kbit/s is 50 bytes per ms: 50 KB takes a second, plus half a millisecond of delay.
    expect(leg.send(50_000, 0)).toBeCloseTo(1000.5, 3);
  });

  it.each([
    { name: "a loss with three segments behind it costs one round trip", lost: 5, extra: 100 },
    { name: "a lost tail waits for the timeout, a round trip plus 200 ms", lost: 8, extra: 300 },
    { name: "the very last segment lost waits for the timeout too", lost: 9, extra: 300 },
  ])("$name", ({ lost, extra }) => {
    const clean = new TcpLeg(fast, never, 0).send(10_000, 0);
    const lossy = new TcpLeg(fast, losing(lost), 0).send(10_000, 0);
    expect(lossy - clean).toBeCloseTo(extra, 0);
  });

  it("holds everything behind a lost segment until it is retransmitted", () => {
    const leg = new TcpLeg(fast, losing(0), 0);
    const first = leg.send(1000, 0);
    const second = leg.send(1000, 1);
    expect(first).toBeCloseTo(100 + 200 + 50, 0);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("counts the messages sent back to back behind a loss, so it is not a tail", () => {
    // Segment 8 of one 10 KB message is a tail; with a second message behind it, it isn't.
    const alone = new TcpLeg(fast, losing(8), 0).send(10_000, 0);
    const [first] = new TcpLeg(fast, losing(8), 0).sendAll([
      { bytes: 10_000, at: 0 },
      { bytes: 10_000, at: 0 },
    ]);
    expect(alone - (first ?? 0)).toBeCloseTo(200, 0);
  });

  it("cuts its window to 0.7 on a loss, then grows it by one per round trip", () => {
    // The last of ten segments is lost: the window goes from 10 to 7.
    const leg = new TcpLeg(fast, losing(9), 0);
    leg.send(10_000, 0);
    expect(leg.windowSegments).toBe(7);
    // 30 more from 150 ms go out 7, 8, 9, then 6 of 10: the last leaves three round trips in.
    expect(leg.send(30_000, 150)).toBeCloseTo(150 + 3 * 100 + 50, 0);
  });

  it("cuts its window the same way on a fast retransmit", () => {
    // Segment 2 is lost: 10 becomes 7, and the seventh segment sent opens a round of 8.
    const leg = new TcpLeg(fast, losing(2), 0);
    leg.send(10_000, 0);
    expect(leg.windowSegments).toBe(8);
  });

  it("restarts slow start after an idle longer than the retransmit timeout", () => {
    const leg = new TcpLeg(fast, never, 0);
    leg.send(150_000, 0);
    expect(leg.windowSegments).toBe(80);
    // Idle for well over the 300 ms timeout: the next send starts from ten segments again.
    const sentAt = 5_000;
    expect(leg.send(30_000, sentAt)).toBeCloseTo(sentAt + 100 + 50, 0);
    expect(leg.windowSegments).toBe(20);
  });

  it("keeps the window when the gap is shorter than the timeout", () => {
    const leg = new TcpLeg(fast, never, 0);
    // 140 segments: rounds of 10, 20, 40, then 70 of a window of 80.
    const done = leg.send(140_000, 0);
    // Ten more right after fit what is left of the window: they land half a round trip later.
    expect(leg.send(10_000, done)).toBeCloseTo(done + 50, 0);
  });

  it("delivers in order even when jitter would reorder", () => {
    const random = seededRandom(7);
    const leg = new TcpLeg({ ...fast, loss: 0, jitterMs: 200 }, random, 0);
    const arrivals = Array.from({ length: 50 }, (_, index) => leg.send(500, index * 10));
    expect(arrivals).toEqual(arrivals.toSorted((a, b) => a - b));
  });
});

describe("the competing flow", () => {
  it("leaves video the whole link before its first burst", () => {
    expect(shared().send(10_000, 0)).toBeCloseTo(200.5, 3);
  });

  it("takes half the link while a burst is unsent", () => {
    // From 1 s the burst and video split 50 bytes per ms: 10 KB takes 400 ms, not 200.
    expect(shared().send(10_000, 1_000)).toBeCloseTo(1_400.5, 3);
  });

  it("gives the link back once the burst is sent", () => {
    const leg = shared();
    // Sharing, video's 25 KB and the burst's first 25 KB go out by 2 s; then the burst has the
    // link alone and its last 25 KB is gone by 2.5 s.
    leg.send(25_000, 1_000);
    expect(leg.competingLeft(2_000)).toBeCloseTo(25_000, 0);
    expect(leg.competingLeft(2_500)).toBe(0);
    expect(leg.send(10_000, 3_000)).toBeCloseTo(3_200.5, 3);
  });

  it("drains at the full rate while video is idle", () => {
    const leg = shared();
    expect(leg.competingLeft(1_500)).toBeCloseTo(25_000, 0);
    expect(leg.competingLeft(2_000)).toBe(0);
    expect(leg.competingLeft(11_000)).toBe(50_000);
  });
});

describe("the 3G profiles", () => {
  it("replay exactly for one seed and differ for another", () => {
    expect(stream(1, "3g-400")).toEqual(stream(1, "3g-400"));
    expect(stream(2, "3g-400")).not.toEqual(stream(1, "3g-400"));
  });

  it.each([
    { name: "3g-400", kbps: 400 },
    { name: "3g-800", kbps: 800 },
    { name: "3g-1600", kbps: 1600 },
  ] as const)("$name delivers no more than its rate", ({ name, kbps }) => {
    const arrivals = stream(3, name);
    const last = arrivals.at(-1) ?? 0;
    const sentKbits = (100 * 20_000 * 8) / 1000;
    expect(sentKbits / (last / 1000)).toBeLessThanOrEqual(kbps);
  });

  it("cross the relay and back in at least the profile's round trip", () => {
    const { down, up } = threeGLink(
      { ...threeGProfiles["3g-1600"], loss: 0, jitterMs: 0 },
      never,
      0,
    );
    const there = down.send(100, 0);
    expect(up.send(100, there)).toBeGreaterThanOrEqual(300);
  });
});

describe("the original link", () => {
  it("queues at its rate, then adds the one-way delay", () => {
    const link = new SimpleLink(8, 60, 0, never);
    // 8 Mbit/s is 1000 bytes per ms.
    expect(link.send(10_000, 0)).toBe(70);
    expect(link.send(10_000, 0)).toBe(80);
    expect(link.send(10_000, 100)).toBe(170);
  });
});
