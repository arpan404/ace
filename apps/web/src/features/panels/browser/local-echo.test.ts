import { describe, expect, it } from "vitest";
import { ScrollEcho, localCursor, nextLatency } from "./local-echo.ts";

const roomy = { x: 1000, y: 1000 };

describe("optimistic scroll", () => {
  it("moves the frame at once, opposite to the scroll in flight", () => {
    const one = new ScrollEcho().sent(1, 0, 120);
    expect(one.offset(roomy)).toEqual({ x: 0, y: -120 });
    expect(one.sent(2, 30, 40).offset(roomy)).toEqual({ x: -30, y: -160 });
  });

  it("keeps the offset through frames the page drew before it had the scroll", () => {
    const echo = new ScrollEcho().sent(1, 0, 100).framed();
    expect(echo.offset(roomy)).toEqual({ x: 0, y: -100 });
  });

  it("drops a scroll's share once a frame after its dispatch arrives, without touching later ones", () => {
    const echo = new ScrollEcho().sent(1, 0, 100).sent(2, 0, 50).dispatched(1).framed();
    expect(echo.offset(roomy)).toEqual({ x: 0, y: -50 });
    expect(echo.idle).toBe(false);
  });

  it("settles to no offset when every scroll shows in a frame", () => {
    const echo = new ScrollEcho().sent(1, 10, 100).dispatched(1).framed();
    expect(echo.offset(roomy)).toEqual({ x: 0, y: 0 });
    expect(echo.idle).toBe(true);
  });

  it("a scroll the page never shows stops moving the frame", () => {
    const echo = new ScrollEcho().sent(1, 0, 100).dropped(1);
    expect(echo.offset(roomy)).toEqual({ x: 0, y: 0 });
  });

  it("clamps the offset at the edges either way", () => {
    const echo = new ScrollEcho().sent(1, -900, 900);
    expect(echo.offset({ x: 200, y: 300 })).toEqual({ x: 200, y: -300 });
  });

  it("answers for an unknown scroll change nothing", () => {
    const echo = new ScrollEcho().sent(1, 0, 100);
    expect(echo.dispatched(9).framed().offset(roomy)).toEqual({ x: 0, y: -100 });
  });
});

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
