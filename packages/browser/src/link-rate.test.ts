import { describe, expect, it } from "vitest";
import type { MediaLinkHint } from "@ace/protocol";
import { LinkRate, linkFloor, outstandingSends } from "./link-rate.ts";
import { simulate, type SimLink } from "../scripts/link-sim.ts";

const limits = { min: linkFloor, max: 16_000_000, initial: 4_000_000 };
const phone = { min: linkFloor, max: 16_000_000, initial: 1_500_000 };
const link = (megabits: number, oneWayMs = 50, loss: Partial<SimLink> = {}): SimLink => ({
  megabits,
  oneWayMs,
  ...loss,
});

describe("a viewer's link rate", () => {
  it("settles just under a link it overruns, without collapsing to the floor", () => {
    const rate = new LinkRate(limits);
    const rates = simulate(rate, { link: link(2), seconds: 20 });
    const settled = rates.slice(-10);
    const mean = settled.reduce((sum, value) => sum + value, 0) / settled.length;
    expect(mean).toBeLessThan(2_200_000);
    expect(mean).toBeGreaterThan(1_400_000);
    for (const value of settled) {
      expect(value).toBeLessThan(3_000_000);
      expect(value).toBeGreaterThan(800_000);
    }
  });

  it("climbs on a roomy link and stays there", () => {
    const rate = new LinkRate(limits);
    expect(simulate(rate, { link: link(100), seconds: 20 }).at(-1)).toBe(limits.max);
  });

  it("falls when the link gets slower", () => {
    const rate = new LinkRate(limits);
    simulate(rate, { link: link(100), seconds: 10 });
    const rates = simulate(rate, { link: link(3), seconds: 15, start: 10_000 }).slice(-8);
    expect(rates.reduce((sum, value) => sum + value, 0) / rates.length).toBeLessThan(3_300_000);
    expect(Math.max(...rates)).toBeLessThan(4_500_000);
  });

  it("follows a 400 kbit/s 3G link down below the old 500 kbit/s floor, and holds above it", () => {
    const rate = new LinkRate(phone);
    const rates = simulate(rate, { link: link(0.4, 200), seconds: 30, fps: 5 }).slice(-15);
    const mean = rates.reduce((sum, value) => sum + value, 0) / rates.length;
    expect(mean).toBeLessThan(500_000);
    expect(mean).toBeGreaterThan(250_000);
    expect(Math.min(...rates)).toBeGreaterThan(200_000);
  });

  it("holds most of a lossy link: 2 % of chunks stalled a round trip are not read as a queue", () => {
    const rate = new LinkRate(phone);
    const lossy = link(1.6, 200, { lossEvery: 50, stallMs: 400 });
    const rates = simulate(rate, { link: lossy, seconds: 30, fps: 15 }).slice(-20);
    expect(rates.reduce((sum, value) => sum + value, 0) / rates.length).toBeGreaterThan(1_100_000);
    expect(Math.min(...rates)).toBeGreaterThan(700_000);
  });

  it("a single retransmit stall out of a calm link does not cut the rate", () => {
    const rate = new LinkRate(phone);
    simulate(rate, { link: link(40, 150), seconds: 10, fps: 15 });
    const before = rate.rate;
    rate.sent(10_000, 2_000, 10_000);
    // A retransmit timeout, backed off to a second: the chunk sent behind it waits too.
    rate.acknowledged(10_000, 10_000 + 300 + 1_000);
    rate.sent(10_001, 2_000, 10_050);
    rate.acknowledged(10_001, 11_300);
    expect(rate.rate).toBeGreaterThanOrEqual(before);
  });

  it("a lone late ack does not cut the rate", () => {
    const rate = new LinkRate(phone);
    simulate(rate, { link: link(8, 50), seconds: 5, fps: 30 });
    const before = rate.rate;
    rate.sent(50_000, 1_000, 5_000);
    rate.acknowledged(50_000, 5_000 + 100 + 700);
    expect(rate.rate).toBeGreaterThanOrEqual(before);
  });

  it("queueing that builds and lasts cuts the rate", () => {
    const rate = new LinkRate(phone);
    simulate(rate, { link: link(8, 50), seconds: 5, fps: 30 });
    const before = rate.rate;
    for (let index = 0; index < 40; index++) {
      rate.sent(60_000 + index, 1_000, 5_000 + index * 50);
      rate.acknowledged(60_000 + index, 5_000 + index * 50 + 100 + Math.min(300, index * 15));
    }
    expect(rate.rate).toBeLessThan(before);
  });

  it("a keyframe's own time on a thin link is not queueing", () => {
    const rate = new LinkRate(phone);
    simulate(rate, { link: link(0.8, 150), seconds: 10, fps: 5 });
    const before = rate.rate;
    // Half a second of the link in one chunk, every 600 ms, on an otherwise idle link.
    const bytes = (800_000 / 8) * 0.5;
    for (let index = 0; index < 6; index++) {
      rate.sent(90_000 + index, bytes, 20_000 + index * 600);
      rate.acknowledged(90_000 + index, 20_000 + index * 600 + 300 + 500);
    }
    expect(rate.rate).toBeGreaterThanOrEqual(before);
  });

  it("a drop with a queue behind it cuts the rate at once", () => {
    const rate = new LinkRate(limits);
    simulate(rate, { link: link(100), seconds: 5 });
    for (let index = 0; index < 12; index++) {
      rate.sent(80_000 + index, 1_000, 5_000 + index * 50);
      rate.acknowledged(80_000 + index, 5_000 + index * 50 + 100 + index * 20);
    }
    const before = rate.rate;
    rate.dropped(5_700);
    expect(rate.rate).toBeLessThan(before * 0.7);
  });

  it("a drop on a calm link is a chunk too big for the time bound, not a slow link", () => {
    const rate = new LinkRate(limits);
    simulate(rate, { link: link(100), seconds: 5 });
    const before = rate.rate;
    rate.dropped(5_100);
    expect(rate.rate).toBe(before);
    expect(rate.probing).toBe(true);
  });

  it("a drop while the oldest chunk is stalled on a loss does not cut", () => {
    const rate = new LinkRate(phone);
    simulate(rate, { link: link(8, 150), seconds: 10, fps: 15 });
    const before = rate.rate;
    rate.sent(70_000, 1_000, 10_000);
    rate.dropped(10_000 + 300 + 500);
    expect(rate.rate).toBe(before);
  });

  it("when acks stop, only the newest sends are remembered for the ack that comes later", () => {
    const start = { min: 500_000, max: 16_000_000, initial: 1_000_000 };
    const bounded = new LinkRate(start);
    const fewer = new LinkRate(start);
    for (let index = 0; index < 1_000; index++) bounded.sent(index, 150, index);
    for (let index = 1_000 - outstandingSends; index < 1_000; index++)
      fewer.sent(index, 150, index);
    bounded.acknowledged(999, 1_020);
    fewer.acknowledged(999, 1_020);
    expect(bounded.rate).toBe(fewer.rate);
    expect(bounded.rtt).toBe(fewer.rtt);
  });

  it("a high but steady round trip is not mistaken for a queue", () => {
    const rate = new LinkRate(limits);
    expect(simulate(rate, { link: link(100, 150), seconds: 20 }).at(-1)).toBe(limits.max);
  });

  it("bounds the bytes in flight to the rate over a round trip plus 300 ms", () => {
    const rate = new LinkRate(phone);
    expect(rate.backlogBytes).toBeUndefined();
    simulate(rate, { link: link(0.4, 200), seconds: 20, fps: 5 });
    const rtt = rate.rtt ?? 0;
    expect(rtt).toBeGreaterThan(300);
    expect(rate.backlogBytes).toBe(Math.round((rate.rate / 8) * ((rtt + 300) / 1000)));
  });
});

/** Where a phone viewer with this hint starts. */
function hintedRate(hint: MediaLinkHint): number {
  return new LinkRate(phone, hint).rate;
}

describe("a link hint", () => {
  it("starts a thin link low, and is no longer a probe", () => {
    const rate = new LinkRate(phone, { effectiveType: "3g" });
    expect(rate.rate).toBe(500_000);
    expect(rate.probing).toBe(false);
    expect(new LinkRate(phone).probing).toBe(true);
  });

  it("never raises the start, and stays within the limits", () => {
    expect(hintedRate({ effectiveType: "4g", downlinkKbps: 100_000 })).toBe(1_500_000);
    expect(hintedRate({ effectiveType: "slow-2g" })).toBe(linkFloor);
    expect(hintedRate({ downlinkKbps: 1 })).toBe(linkFloor);
    expect(hintedRate({ saveData: true })).toBe(linkFloor);
    expect(hintedRate({ downlinkKbps: 700 })).toBe(350_000);
  });

  it("only picks the start: the rate still climbs no faster than the link proves", () => {
    const hinted = new LinkRate(phone, { effectiveType: "3g" });
    const rates = simulate(hinted, { link: link(0.4, 200), seconds: 20, fps: 5 });
    // Nothing near the 1.5 Mbit/s an unhinted viewer would start at.
    expect(Math.max(...rates)).toBeLessThan(700_000);
  });
});

/** Ten chunks a second from `from`, each the rate's tenth, acked `rtt(index)` ms later. */
function steady(rate: LinkRate, count: number, from: number, rtt: (index: number) => number) {
  for (let index = 0; index < count; index++) {
    const at = from + index * 100;
    const sequence = Math.round(at / 100);
    rate.sent(sequence, Math.round(rate.rate / 80), at);
    rate.acknowledged(sequence, at + rtt(index));
  }
}

/** A calm second at 300 ms, then a queue that builds to 700 ms and stays: the first cut. */
function firstCut(): { rate: LinkRate; peak: number } {
  const rate = new LinkRate(phone);
  steady(rate, 10, 0, () => 300);
  const peak = rate.rate;
  steady(rate, 15, 1_000, (index) => 300 + Math.min(700, index * 50));
  return { rate, peak };
}

describe("after the first cut", () => {
  it("drains the start's queue below what is delivered, then measures the floor afresh", () => {
    const { rate, peak } = firstCut();
    // The drain holds the rate to half of what the link delivered: well under the start's peak.
    expect(rate.rate).toBeLessThan(peak / 2);
    const draining = rate.rate;
    steady(rate, 30, 2_500, () => 320);
    // Then the round trip comes from fresh samples only: the old queue is gone from it.
    expect(rate.rtt).toBeLessThanOrEqual(320);
    expect(rate.rate).toBeGreaterThan(draining);
  });

  it("probes back up faster once the link has been calm a few round trips", () => {
    const { rate } = firstCut();
    steady(rate, 30, 2_500, () => 320);
    const from = rate.rate;
    // About ten rises in 3.8 s of calm: past the first three round trips, each is 10 %, not 8 %.
    steady(rate, 38, 5_500, () => 320);
    expect(rate.rate / from).toBeGreaterThan(1.08 ** 10);
  });
});
