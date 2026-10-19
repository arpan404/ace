import { describe, expect, it } from "vitest";
import { contentsScale, headlessOverride } from "./headless-size.ts";

/** Screencast pixels across: the window's width at the browser's process-wide scale. */
const framePixels = (contentsWidth: number, browserScale: number) => contentsWidth * browserScale;

describe("the page renders as sharp as the viewer's screen", () => {
  it("a DPR 3 phone gets a 3x picture from a browser running at 2x, at the same CSS size", () => {
    const metrics = { viewport: { width: 390, height: 800 } };
    const { override, contents } = headlessOverride(metrics, 2, 3);
    expect(override).toMatchObject({ width: 390, height: 800, deviceScaleFactor: 3 });
    expect(framePixels(contents.width, 2)).toBe(1170);
    expect(contentsScale(metrics, 2, 3)).toBe(1.5);
  });

  it("a screen no denser than the browser's scale changes nothing", () => {
    const metrics = { viewport: { width: 1280, height: 720 } };
    expect(headlessOverride(metrics, 2, 1)).toEqual(headlessOverride(metrics, 2));
    expect(contentsScale(metrics, 2, 2)).toBe(1);
  });

  it("density stops at 3 and at the largest frame the capture sends", () => {
    expect(contentsScale({ viewport: { width: 300, height: 600 } }, 2, 4)).toBe(1.5);
    const wide = { viewport: { width: 1000, height: 700 } };
    expect(framePixels(headlessOverride(wide, 2, 3).contents.width, 2)).toBe(2560);
  });

  it("zoom keeps the picture's size while the denser scale still applies", () => {
    const { override, contents } = headlessOverride(
      { viewport: { width: 400, height: 600 }, zoom: 2 },
      2,
      3,
    );
    expect(override).toMatchObject({ width: 200, height: 300, deviceScaleFactor: 6 });
    expect(framePixels(contents.width, 2)).toBe(1200);
  });

  it("an emulated device keeps its own scale and window", () => {
    const metrics = {
      viewport: { width: 1280, height: 720 },
      device: { width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
    };
    expect(headlessOverride(metrics, 2, 3)).toEqual(headlessOverride(metrics, 2));
    expect(contentsScale(metrics, 2, 3)).toBe(1);
  });
});
