import { describe, expect, it } from "vitest";
import { firstTab, tabForKey } from "./tab-keys.ts";

describe("moving between tabs with the keyboard", () => {
  it("steps right and wraps from the last tab to the first", () => {
    expect(tabForKey("ArrowRight", 1, 4)).toBe(2);
    expect(tabForKey("ArrowRight", 3, 4)).toBe(0);
  });

  it("steps left and wraps from the first tab to the last", () => {
    expect(tabForKey("ArrowLeft", 2, 4)).toBe(1);
    expect(tabForKey("ArrowLeft", 0, 4)).toBe(3);
  });

  it("jumps to the ends with Home and End", () => {
    expect(tabForKey("Home", 2, 4)).toBe(0);
    expect(tabForKey("End", 0, 4)).toBe(3);
  });

  it("ignores other keys and empty lists", () => {
    expect(tabForKey("Enter", 1, 4)).toBeUndefined();
    expect(tabForKey("ArrowRight", 0, 0)).toBeUndefined();
  });
});

describe("the tab that opens first", () => {
  const names = ["mac", "windows", "linux", "phone"];

  it("is the visitor's own platform when it has a tab", () => {
    expect(firstTab(names, "linux")).toBe(2);
  });

  it("is the first tab when the visitor's platform is unknown or has none", () => {
    expect(firstTab(names, undefined)).toBe(0);
    expect(firstTab(names, "android")).toBe(0);
  });
});
