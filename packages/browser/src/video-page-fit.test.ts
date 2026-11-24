import { describe, expect, it } from "vitest";
import { fitVideoPage } from "./video-page-fit.ts";

describe("fitting a page into a video header", () => {
  it("leaves a page the client takes unchanged", () => {
    expect(fitVideoPage({ width: 1280, height: 800, scale: 1 })).toEqual({
      width: 1280,
      height: 800,
      scale: 1,
      factor: 1,
    });
  });

  it("scales an oversized page down keeping the aspect and its pixels", () => {
    expect(fitVideoPage({ width: 5120, height: 3200, scale: 1 })).toEqual({
      width: 4096,
      height: 2560,
      scale: 1.25,
      factor: 1.25,
    });
  });

  it("scales a tiny page up until its smaller side clears 100", () => {
    const fitted = fitVideoPage({ width: 40, height: 30, scale: 1 });
    expect(fitted.width).toBe(133);
    expect(fitted.height).toBe(100);
    expect(fitted.factor).toBeLessThan(1);
    expect(fitted.width * fitted.scale).toBeCloseTo(40);
  });
});
