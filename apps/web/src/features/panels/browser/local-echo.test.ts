import { describe, expect, it } from "vitest";
import { localCursor, nextLatency } from "./local-echo.ts";

describe("input latency readout", () => {
  it("takes the first round trip as it is and moves part way toward later ones", () => {
    const first = nextLatency(undefined, 140);
    expect(first).toBe(140);
    const slow = nextLatency(first, 540);
    expect(slow).toBeGreaterThan(140);
    expect(slow).toBeLessThan(540);
  });

  it("ignores impossible samples", () => {
    expect(nextLatency(100, -5)).toBe(100);
    expect(nextLatency(100, Number.NaN)).toBe(100);
  });
});

describe("local cursor", () => {
  it("shows the page's cursor shape and the arrow for anything unknown", () => {
    expect(localCursor("pointer")).toBe("pointer");
    expect(localCursor(" Text ")).toBe("text");
    expect(localCursor(undefined)).toBe("default");
    expect(localCursor("auto")).toBe("default");
    expect(localCursor("url(evil.png), pointer")).toBe("default");
  });
});
