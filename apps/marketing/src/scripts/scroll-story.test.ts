import { describe, expect, it } from "vitest";
import { centredScroll, readingLine } from "./scroll-story.ts";

describe("an inner page's story", () => {
  it("a step becomes current at the middle of the screen beside the stage", () => {
    expect(readingLine(900, 0)).toBe(450);
  });

  it("under a stage pinned across the top, a step becomes current mid-way down what is left", () => {
    expect(readingLine(800, 400)).toBe(600);
  });

  it("the index row brings the current name to its middle, never scrolling past either end", () => {
    const row = { width: 300, scrollWidth: 1000 };
    expect(centredScroll({ left: 500, width: 100 }, row)).toBe(400);
    expect(centredScroll({ left: 20, width: 100 }, row)).toBe(0);
    expect(centredScroll({ left: 950, width: 50 }, row)).toBe(700);
  });
});
