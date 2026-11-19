import { describe, expect, it } from "vitest";
import { aceMarkBox, aceWing } from "../brand/mark.ts";
import { inside, markRows, outline } from "./ascii-mark.ts";

const grid = { wing: aceWing, box: aceMarkBox, columns: 60, cell: 0.5, word: "ace" };

describe("the mark set in type", () => {
  it("draws the two wings as mirror images of each other", () => {
    for (const row of markRows(grid)) {
      const padded = row.padEnd(grid.columns);
      const shape = [...padded].map((char) => char !== " ");
      expect(shape).toEqual(shape.toReversed());
    }
  });

  it("leaves the diamond between the wings open", () => {
    const rows = markRows(grid);
    const middle = rows[Math.floor(rows.length / 2)]?.padEnd(grid.columns) ?? "";
    expect(middle.slice(28, 32).trim()).toBe("");
    expect(middle.trim()).not.toBe("");
  });

  it("fills the mark's own width and keeps its proportions", () => {
    const rows = markRows(grid);
    expect(Math.max(...rows.map((row) => row.length))).toBe(grid.columns);
    expect(
      rows.some((row) => row.startsWith("a") || row.startsWith("c") || row.startsWith("e")),
    ).toBe(true);
    // The mark is about 21 units wide and 18 tall; cells are twice as tall as wide.
    expect(rows.length).toBeGreaterThan(22);
    expect(rows.length).toBeLessThan(28);
  });

  it("writes the word along each row, a letter later on each row down", () => {
    const rows = markRows(grid);
    rows.forEach((row, at) => {
      [...row].forEach((char, column) => {
        if (char !== " ") expect(char).toBe("ace"[(column + at) % 3]);
      });
    });
  });

  it("takes twice the rows when cells are half as tall", () => {
    const tall = markRows(grid).length;
    const short = markRows({ ...grid, cell: 1 }).length;
    expect(Math.abs(short - tall * 2)).toBeLessThanOrEqual(1);
  });
});

describe("outline", () => {
  it("knows inside from outside for a path with lines and a curve", () => {
    const shape = outline("M0 0L10 0C10 5 10 5 10 10H0V0Z");
    expect(inside(shape, 5, 5)).toBe(true);
    expect(inside(shape, 11, 5)).toBe(false);
    expect(inside(shape, 5, -1)).toBe(false);
  });
});
