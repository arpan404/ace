import { describe, expect, it } from "vitest";
import { PictureScale, keepFramesBpp } from "./video-scale.ts";

const pixels = 2560 * 1600;
const carried = (link: number, scale: number) => link / (pixels * scale ** 2 * 60);

describe("the picture a link carries at 60 fps", () => {
  it("a roomy link keeps the full picture", () => {
    expect(new PictureScale().update(16_000_000, pixels, 60, 0)).toBe(1);
  });

  it("the first picture on a thin link is already one the link carries", () => {
    const scale = new PictureScale().update(1_000_000, pixels, 60, 0);
    expect(scale).toBeLessThan(1);
    expect(carried(1_000_000, scale)).toBeGreaterThanOrEqual(keepFramesBpp);
  });

  it("a link that falls short for a second gets a smaller picture; a brief dip doesn't", () => {
    const scale = new PictureScale();
    scale.update(16_000_000, pixels, 60, 0);
    expect(scale.update(1_000_000, pixels, 60, 100)).toBe(1);
    expect(scale.update(16_000_000, pixels, 60, 600)).toBe(1);
    scale.update(1_000_000, pixels, 60, 700);
    const shrunk = scale.update(1_000_000, pixels, 60, 1_700);
    expect(shrunk).toBeLessThan(1);
    expect(carried(1_000_000, shrunk)).toBeGreaterThanOrEqual(keepFramesBpp);
  });

  it("grows back straight to the largest picture once the link has had room for a while", () => {
    const scale = new PictureScale();
    const small = scale.update(1_000_000, pixels, 60, 0);
    expect(scale.update(16_000_000, pixels, 60, 1_000)).toBe(small);
    expect(scale.update(16_000_000, pixels, 60, 4_000)).toBe(1);
  });
});
