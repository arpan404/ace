import { describe, expect, it } from "vitest";
import { nextLatency, pageConnection } from "./browser-connection.ts";

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

describe("page connection", () => {
  it.each([
    ["https://shop.example/cart", "secure"],
    ["http://shop.example/cart", "insecure"],
    ["shop.example", "insecure"],
    ["http://localhost:5173/", "local"],
    ["http://127.0.0.1:3000", "local"],
    ["http://app.localhost/", "local"],
    [undefined, "local"],
    ["", "local"],
  ] as const)("%s reads as %s", (url, expected) => {
    expect(pageConnection(url)).toBe(expected);
  });
});
