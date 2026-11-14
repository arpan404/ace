import { describe, expect, it } from "vitest";
import {
  PictureScale,
  framesBpp,
  keyframeSeconds,
  readableSide,
  stepNeeds,
} from "./video-scale.ts";

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

  it("below 15 fps the picture first shrinks, at 15 fps, but no smaller than readable text", () => {
    const steps = [6e6, 3e6, 1.2e6, 900e3, 600e3, 300e3, 150e3].map((link) =>
      new PictureScale().update({ ...at(link, 0), side: 2560 }),
    );
    // About 720p at 15 fps on a 3G link that has 1.2 Mbit/s left: not 5 fps of a full picture.
    const thin = steps[2];
    expect(thin?.fps).toBe(15);
    expect(2560 * (thin?.scale ?? 0)).toBeGreaterThanOrEqual(readableSide);
    for (const step of steps)
      if (step.fps === 15) expect(2560 * step.scale).toBeGreaterThanOrEqual(readableSide);
    // Below that the frame rate drops at the readable size, and only then the size again.
    const slower = steps.filter((step) => step.fps < 15);
    expect(slower.length).toBeGreaterThan(0);
    const fps = steps.map((step) => step.fps);
    expect(fps).toEqual(fps.toSorted((a, b) => b - a));
    expect(steps.at(-1)?.scale).toBeLessThan(readableSide / 2560);
  });

  it("a picture already near readable size keeps its pixels and loses frames", () => {
    const small = { ...at(450e3, 0), pixels: 1170 * 720, side: 1170 };
    const step = new PictureScale().update(small);
    expect(step.scale).toBe(1);
    expect(step.fps).toBeLessThan(15);
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

/** A one-megapixel view at 60 fps, its link measured. */
function megapixel(link: number, now: number) {
  return { link, pixels: 1_000_000, fps: 60, now };
}

describe("stepping back up", () => {
  it("more frames at the same size come back after 1 s, not the size step's 3 s", () => {
    const scale = new PictureScale();
    expect(scale.update(megapixel(900e3, 0))).toEqual({ scale: 1, fps: 30 });
    expect(scale.update(megapixel(2e6, 100))).toEqual({ scale: 1, fps: 30 });
    expect(scale.update(megapixel(2e6, 1_099))).toEqual({ scale: 1, fps: 30 });
    expect(scale.update(megapixel(2e6, 1_100))).toEqual({ scale: 1, fps: 60 });
  });

  it("a higher target waits its own time: a spike doesn't inherit a smaller step's timer", () => {
    const scale = new PictureScale();
    const low = scale.update(at(1.2e6, 0));
    expect(low.scale).toBeLessThan(1);
    // A modest step up qualifies from 100 ms and is pending...
    expect(scale.update(at(2.2e6, 100))).toEqual(low);
    expect(scale.update(at(2.2e6, 3_099))).toEqual(low);
    // ...then the link spikes: full size at 60 fps is a new target, with a fresh 3 s.
    expect(scale.update(at(16e6, 3_100))).toEqual(low);
    expect(scale.update(at(16e6, 6_099))).not.toEqual({ scale: 1, fps: 60 });
    expect(scale.update(at(16e6, 6_100))).toEqual({ scale: 1, fps: 60 });
  });
});
