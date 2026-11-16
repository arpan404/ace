import { describe, expect, it } from "vitest";
import { DeliveryWindow } from "./delivery-window.ts";

/** Bits per second of `bytes` over a window of `ms`. */
const rate = (bytes: number, ms: number) => (bytes * 8 * 1000) / ms;

describe("what a link delivered, by time", () => {
  it("counts an ack's bytes at its own time, however many acks came before it", () => {
    const window = new DeliveryWindow();
    // 256 small acks in the first 256 ms, then one large ack at 1.5 s.
    for (let at = 0; at < 256; at++) window.add(at, 10);
    window.add(1_500, 100_000);
    // At 2 s the large ack is half a second old: inside the 1 s window.
    expect(window.rates(2_000).recent).toBe(rate(100_000, 1_000));
  });

  it("drops bytes from the 1 s window once they are a second old, and the 2 s one at two", () => {
    const window = new DeliveryWindow();
    window.add(1_500, 100_000);
    expect(window.rates(2_499).recent).toBe(rate(100_000, 1_000));
    expect(window.rates(2_510).recent).toBe(0);
    expect(window.rates(3_499).longer).toBe(rate(100_000, 2_000));
    expect(window.rates(3_510).longer).toBe(0);
  });

  it("holds any number of acks in its fixed buckets", () => {
    const window = new DeliveryWindow();
    for (let index = 0; index < 10_000; index++) window.add(index * 0.3, 100);
    // The last 2 s held 2,000 / 0.3 acks of 100 bytes each, give or take a bucket.
    const longer = window.rates(3_000).longer;
    expect(longer).toBeGreaterThan(rate(100 * 6_600, 2_000));
    expect(longer).toBeLessThanOrEqual(rate(100 * 6_700, 2_000));
  });
});
