import { describe, expect, it } from "vitest";
import { blinkDelay, gazeToward, readGaze } from "./spade-gaze.ts";

const face = { left: 100, top: 100, width: 60, height: 60 };

describe("where a drawn bot looks", () => {
  it("looks straight right at a pointer far to its right", () => {
    expect(gazeToward(face, { x: 900, y: 130 })).toEqual({ x: 1, y: 0 });
  });

  it("looks up and left toward a pointer above and left of it", () => {
    const look = gazeToward(face, { x: 0, y: 0 });
    expect(look.x).toBeLessThan(0);
    expect(look.y).toBeLessThan(0);
    expect(Math.hypot(look.x, look.y)).toBeCloseTo(1, 1);
  });

  it("barely moves its eyes for a pointer resting on the face", () => {
    const look = gazeToward(face, { x: 135, y: 130 });
    expect(Math.hypot(look.x, look.y)).toBeLessThan(0.2);
  });

  it("looks ahead when the pointer is exactly on its centre", () => {
    expect(gazeToward(face, { x: 130, y: 130 })).toEqual({ x: 0, y: 0 });
  });

  it("reads a resting look from the page and keeps it inside the eye", () => {
    expect(readGaze("0.5, -0.25")).toEqual({ x: 0.5, y: -0.25 });
    expect(readGaze("3,-9")).toEqual({ x: 1, y: -1 });
  });

  it("ignores a resting look that isn't two numbers", () => {
    expect(readGaze("left")).toBeUndefined();
    expect(readGaze("1")).toBeUndefined();
    expect(readGaze(null)).toBeUndefined();
  });

  it("blinks every few seconds, never in a flurry", () => {
    expect(blinkDelay(0)).toBe(2600);
    expect(blinkDelay(0.999)).toBeLessThanOrEqual(5800);
    expect(blinkDelay(-4)).toBe(2600);
  });
});
