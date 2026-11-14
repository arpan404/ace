import { describe, expect, it } from "vitest";
import { affordsSettleKey, QuantizerControl } from "./quantizer-control.ts";

/**
 * A stand-in encoder whose frames cost `cost(quantizer)` bytes: each +6 halves a frame, as
 * H.264 and HEVC roughly behave.
 */
function run(control: QuantizerControl, bytesAt24: number, frames: number): number[] {
  const sizes: number[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const quantizer = control.next(false);
    const bytes = bytesAt24 / 2 ** ((quantizer - 24) / 6);
    control.observe(bytes, false);
    sizes.push(bytes);
  }
  return sizes;
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("ace's own rate control for quantizer-mode encoders", () => {
  it("settles frames near the bit rate's share per frame", () => {
    const control = new QuantizerControl(1_000_000, 60);
    const sizes = run(control, 40_000, 240);
    const target = 1_000_000 / 60 / 8;
    expect(average(sizes.slice(-60))).toBeGreaterThan(target * 0.7);
    expect(average(sizes.slice(-60))).toBeLessThan(target * 1.4);
  });

  it("follows a new bit rate", () => {
    const control = new QuantizerControl(4_000_000, 60);
    run(control, 40_000, 240);
    control.retarget(1_000_000, 60);
    const sizes = run(control, 40_000, 240);
    expect(average(sizes.slice(-60))).toBeLessThan((1_000_000 / 60 / 8) * 1.4);
  });

  it("codes a keyframe coarser than the deltas around it", () => {
    const control = new QuantizerControl(2_000_000, 60);
    expect(control.next(true)).toBeGreaterThan(control.next(false));
  });

  it("never codes finer than it is worth, on content that costs nothing", () => {
    const control = new QuantizerControl(16_000_000, 60);
    run(control, 100, 600);
    expect(control.next(false)).toBe(18);
  });

  it("a still page's picture is coded again finer, as fine as half a second of the link affords", () => {
    const bitrate = 16_000_000;
    const control = new QuantizerControl(bitrate, 60);
    const keyQuantizer = control.next(true);
    const keyBytes = 110_000;
    control.observe(keyBytes, true);
    const onScreen = control.next(false);
    control.observe(500, false);
    const sharper = control.settled();
    if (sharper === undefined) throw new Error("No sharper picture");
    expect(sharper).toBeLessThan(onScreen);
    // At the stand-in's cost (+6 halves a picture) the sharper keyframe fits half a second.
    const cost = keyBytes * 2 ** ((keyQuantizer - sharper) / 6);
    expect(cost * 8).toBeLessThanOrEqual(bitrate * 0.5 * 1.1);
    expect(cost * 8).toBeGreaterThan(bitrate * 0.5 * 0.7);
    // Once is enough while the page stays still.
    expect(control.settled()).toBeUndefined();
  });

  it("a thin link gets no sharper picture than it can carry", () => {
    const control = new QuantizerControl(1_000_000, 60);
    control.next(true);
    control.observe(110_000, true);
    control.next(false);
    expect(control.settled()).toBeUndefined();
  });

  it("an encoder sizing its own keyframes sends a sharp one only when the link carries it", () => {
    expect(affordsSettleKey(110_000 * 8, 16_000_000)).toBe(true);
    expect(affordsSettleKey(110_000 * 8, 1_500_000)).toBe(false);
    expect(affordsSettleKey(undefined, 16_000_000)).toBe(false);
  });

  it("a keyframe's size does not steer the deltas", () => {
    const control = new QuantizerControl(1_000_000, 60);
    const before = control.next(false);
    for (let i = 0; i < 10; i++) control.observe(1_000_000, true);
    expect(control.next(false)).toBe(before);
  });
});

/** A keyframe that costs `bytesAt24` at quantizer 24, halving each +6. */
function keyAt(control: QuantizerControl, bytesAt24: number): number {
  const quantizer = control.next(true);
  const bytes = bytesAt24 / 2 ** ((quantizer - 24) / 6);
  control.observe(bytes, true);
  return bytes;
}

describe("the keyframe cap", () => {
  it("holds a keyframe to half a second of a 3G link, judged from the last one", () => {
    const control = new QuantizerControl(400_000, 5);
    run(control, 20_000, 30);
    // The first keyframe on a dense page runs far over: nothing has shown what one costs.
    expect(keyAt(control, 400_000) * 8).toBeGreaterThan(400_000 * 0.5);
    for (let index = 0; index < 3; index++) {
      run(control, 20_000, 10);
      expect(keyAt(control, 400_000) * 8).toBeLessThanOrEqual(400_000 * 0.5);
    }
  });

  it("leaves a keyframe that fits as the deltas around it set it", () => {
    const capped = new QuantizerControl(16_000_000, 60);
    run(capped, 10_000, 30);
    keyAt(capped, 5_000);
    run(capped, 10_000, 10);
    const plain = new QuantizerControl(16_000_000, 60);
    run(plain, 10_000, 40);
    expect(capped.next(true)).toBe(plain.next(true));
  });
});
