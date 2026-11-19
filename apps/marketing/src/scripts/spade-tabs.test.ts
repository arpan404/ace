import { describe, expect, it } from "vitest";
import { tabAfter } from "./spade-tabs.ts";

describe("moving through a tab list with the keyboard", () => {
  it("steps forward and back with the arrows, wrapping at the ends", () => {
    expect(tabAfter("ArrowDown", 0, 4)).toBe(1);
    expect(tabAfter("ArrowRight", 3, 4)).toBe(0);
    expect(tabAfter("ArrowUp", 0, 4)).toBe(3);
    expect(tabAfter("ArrowLeft", 2, 4)).toBe(1);
  });

  it("jumps to the first and last tab with Home and End", () => {
    expect(tabAfter("Home", 2, 4)).toBe(0);
    expect(tabAfter("End", 0, 4)).toBe(3);
  });

  it("leaves other keys to the page", () => {
    expect(tabAfter("Enter", 1, 4)).toBeUndefined();
    expect(tabAfter("a", 1, 4)).toBeUndefined();
  });
});
