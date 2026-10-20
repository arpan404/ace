import { describe, expect, it } from "vitest";
import { PictureScale } from "./video-scale.ts";

const pixels = 2560 * 1600;

describe("the picture a link carries at 60 fps", () => {
  it("a roomy link keeps the full picture", () => {
    const scale = new PictureScale();
    expect(scale.update(16_000_000, pixels, 60, 0)).toBe(1);
  });

  it("a thin link gets a smaller picture once it has stayed thin for a second", () => {
    const scale = new PictureScale();
    expect(scale.update(1_000_000, pixels, 60, 0)).toBe(1);
    const shrunk = scale.update(1_000_000, pixels, 60, 1_000);
    expect(shrunk).toBeLessThan(1);
    // The smaller picture is one the link carries at the encoder's needed bits per pixel.
    expect(1_000_000 / (pixels * shrunk ** 2 * 60)).toBeGreaterThanOrEqual(0.02);
  });

  it("a brief dip doesn't change the picture", () => {
    const scale = new PictureScale();
    scale.update(1_000_000, pixels, 60, 0);
    expect(scale.update(16_000_000, pixels, 60, 500)).toBe(1);
    expect(scale.update(1_000_000, pixels, 60, 1_200)).toBe(1);
  });

  it("grows back one step at a time after the link has had room for a while", () => {
    const scale = new PictureScale();
    scale.update(1_000_000, pixels, 60, 0);
    const small = scale.update(1_000_000, pixels, 60, 1_000);
    expect(scale.update(16_000_000, pixels, 60, 2_000)).toBe(small);
    const bigger = scale.update(16_000_000, pixels, 60, 5_000);
    expect(bigger).toBeGreaterThan(small);
    expect(bigger).toBeLessThan(1);
  });
});
