import { describe, expect, it } from "vitest";
import { PictureScale, framesBpp, keyframeSeconds, stepNeeds } from "./video-scale.ts";

const pixels = 2560 * 1600;
/** Bits per pixel per frame a step gets from a link. */
const carried = (link: number, step: { scale: number; fps: number }) =>
  link / (pixels * step.scale ** 2 * step.fps);
const at = (link: number, now: number, probing = false) => ({
  link,
  pixels,
  fps: 60,
  now,
  probing,
});

describe("the picture and frame rate a link carries", () => {
  it("a roomy link keeps the full picture at 60 fps", () => {
    expect(new PictureScale().update(at(16_000_000, 0))).toEqual({ scale: 1, fps: 60 });
  });

  it("a measured thin link loses frames before pixels: 60, 30, 15, 8, 5 fps, then size", () => {
    const steps = [6_000_000, 4_000_000, 2_500_000, 2_100_000, 1_000_000, 400_000].map((link) =>
      new PictureScale().update(at(link, 0)),
    );
    const fps = steps.map((step) => step.fps);
    expect(fps).toEqual(fps.toSorted((a, b) => b - a));
    // Every frame rate step comes at full size; the picture shrinks only at 5 fps.
    for (const step of steps) if (step.scale < 1) expect(step.fps).toBe(5);
    expect(steps.at(-1)?.scale).toBeLessThan(1);
    expect(new Set(fps).size).toBeGreaterThan(3);
  });

  it("while the rate is still probing, the picture shrinks first and keeps 60 fps", () => {
    const step = new PictureScale().update(at(1_500_000, 0, true));
    expect(step.fps).toBe(60);
    expect(step.scale).toBeLessThan(1);
    expect(carried(1_500_000, step)).toBeGreaterThanOrEqual(framesBpp(60));
  });

  it("the first picture on a thin link is already one the link carries, keyframe included", () => {
    const step = new PictureScale().update(at(400_000, 0));
    expect(stepNeeds(pixels, step)).toBeLessThanOrEqual(400_000);
    expect(carried(400_000, step)).toBeGreaterThanOrEqual(framesBpp(step.fps));
    // A keyframe of the picture fits half a second of the link.
    expect(pixels * step.scale ** 2 * 0.25).toBeLessThanOrEqual(400_000 * keyframeSeconds);
  });

  it("a link that falls short for a second gets a smaller step; a brief dip doesn't", () => {
    const scale = new PictureScale();
    scale.update(at(16_000_000, 0));
    expect(scale.update(at(1_000_000, 100))).toEqual({ scale: 1, fps: 60 });
    expect(scale.update(at(16_000_000, 600))).toEqual({ scale: 1, fps: 60 });
    scale.update(at(1_000_000, 700));
    const lower = scale.update(at(1_000_000, 1_700));
    expect(lower.fps).toBeLessThan(60);
    expect(stepNeeds(pixels, lower)).toBeLessThanOrEqual(1_000_000);
  });

  it("climbs back straight to the largest step once the link has had room for a while", () => {
    const scale = new PictureScale();
    const small = scale.update(at(1_000_000, 0));
    expect(scale.update(at(16_000_000, 1_000))).toEqual(small);
    expect(scale.update(at(16_000_000, 4_000))).toEqual({ scale: 1, fps: 60 });
  });

  it("a view that asks for fewer frames starts its ladder there", () => {
    const step = new PictureScale().update({ ...at(16_000_000, 0), fps: 30 });
    expect(step).toEqual({ scale: 1, fps: 30 });
    const thin = new PictureScale().update({ ...at(2_000_000, 0), fps: 30 });
    expect(thin.fps).toBeLessThan(30);
  });
});
