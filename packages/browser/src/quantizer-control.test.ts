import { describe, expect, it } from "vitest";
import { QuantizerControl } from "./quantizer-control.ts";

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

  it("a keyframe's size does not steer the deltas", () => {
    const control = new QuantizerControl(1_000_000, 60);
    const before = control.next(false);
    for (let i = 0; i < 10; i++) control.observe(1_000_000, true);
    expect(control.next(false)).toBe(before);
  });
});
