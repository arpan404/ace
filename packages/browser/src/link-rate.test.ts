import { describe, expect, it } from "vitest";
import { LinkRate } from "./link-rate.ts";

const limits = { min: 500_000, max: 16_000_000, initial: 4_000_000 };

/**
 * A simulated link: chunks queue at `megabits`, then take `oneWay` ms each way. Sends 60 chunks
 * a second of the size the current rate allows, for `seconds`, and returns the rate each second.
 */
let sequence = 0;
function drive(rate: LinkRate, megabits: number, seconds: number, oneWay = 50, start = 0) {
  const bytesPerMs = (megabits * 1e6) / 8 / 1000;
  const acks: { at: number; sequence: number }[] = [];
  let linkFreeAt = start;
  const rates: number[] = [];
  for (let at = start; at < start + seconds * 1000; at += 1000 / 60) {
    while (acks.length && (acks[0]?.at ?? Infinity) <= at) {
      const ack = acks.shift();
      if (ack) rate.acknowledged(ack.sequence, ack.at);
    }
    const bytes = Math.round(rate.rate / 8 / 60);
    rate.sent(++sequence, bytes, at);
    linkFreeAt = Math.max(linkFreeAt, at) + bytes / bytesPerMs;
    acks.push({ at: linkFreeAt + 2 * oneWay, sequence });
    if (Math.round(at - start) % 1000 < 17 && at > start) rates.push(rate.rate);
  }
  return rates;
}

describe("a viewer's link rate", () => {
  it("settles just under a link it overruns, without collapsing to the floor", () => {
    const rate = new LinkRate(limits);
    const rates = drive(rate, 2, 20);
    const settled = rates.slice(-5);
    for (const value of settled) {
      expect(value).toBeLessThan(2_500_000);
      expect(value).toBeGreaterThan(1_000_000);
    }
  });

  it("climbs on a roomy link and stays there", () => {
    const rate = new LinkRate(limits);
    const rates = drive(rate, 100, 20);
    expect(rates.at(-1)).toBe(limits.max);
  });

  it("falls when the link gets slower", () => {
    const rate = new LinkRate(limits);
    drive(rate, 100, 10);
    const rates = drive(rate, 3, 10, 50, 10_000);
    expect(rates.at(-1)).toBeLessThan(3_300_000);
  });

  it("a dropped chunk cuts the rate at once", () => {
    const rate = new LinkRate(limits);
    drive(rate, 100, 5);
    const before = rate.rate;
    rate.dropped(5_100);
    expect(rate.rate).toBeLessThan(before * 0.7);
  });

  it("a high but steady round trip is not mistaken for a queue", () => {
    const rate = new LinkRate(limits);
    const rates = drive(rate, 100, 20, 150);
    expect(rates.at(-1)).toBe(limits.max);
  });
});
