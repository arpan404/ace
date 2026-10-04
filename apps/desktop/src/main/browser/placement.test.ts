import { describe, expect, it } from "vitest";
import { PlacementBook, toWindowBounds } from "./placement.ts";

const panel = { x: 920, y: 120, width: 520, height: 780 };
const other = { x: 400, y: 80, width: 600, height: 500 };

describe("embedded view placement", () => {
  it("shows a thread's view where its renderer places it", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, panel, true)).toEqual({ host: 1, bounds: panel, visible: true });
  });

  it("stays hidden until a renderer has placed it", () => {
    expect(new PlacementBook().resolve("t1")).toEqual({
      host: undefined,
      bounds: undefined,
      visible: false,
    });
  });

  it("hides the view when its tab stops showing, keeping its window and box", () => {
    const book = new PlacementBook();
    book.set("t1", 1, panel, true);
    expect(book.set("t1", 1, panel, false)).toEqual({ host: 1, bounds: panel, visible: false });
  });

  it("never shows a view in an empty box (a collapsed panel)", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, { ...panel, width: 0 }, true).visible).toBe(false);
  });

  it("moves the view to the window that showed it most recently", () => {
    const book = new PlacementBook();
    book.set("t1", 1, panel, true);
    expect(book.set("t1", 2, other, true)).toEqual({ host: 2, bounds: other, visible: true });
  });

  it("keeps the view showing in one window when another window hides its tab", () => {
    const book = new PlacementBook();
    book.set("t1", 1, panel, true);
    book.set("t1", 2, other, true);
    expect(book.set("t1", 2, other, false)).toEqual({ host: 1, bounds: panel, visible: true });
  });

  it("forgets a reloaded renderer's placements, so its old box never shows again", () => {
    const book = new PlacementBook();
    book.set("t1", 1, panel, true);
    book.set("t2", 1, other, true);
    book.set("t2", 2, panel, false);
    expect(book.forgetHost(1).toSorted()).toEqual(["t1", "t2"]);
    expect(book.resolve("t1").visible).toBe(false);
    expect(book.resolve("t2")).toEqual({ host: 2, bounds: panel, visible: false });
  });

  it("keeps thread views apart", () => {
    const book = new PlacementBook();
    book.set("t1", 1, panel, true);
    book.set("t2", 1, other, false);
    expect(book.resolve("t1").visible).toBe(true);
    expect(book.resolve("t2").visible).toBe(false);
  });
});

describe("window bounds", () => {
  it("scales a zoomed page's CSS box to window DIPs", () => {
    expect(toWindowBounds({ x: 100, y: 50, width: 400, height: 300 }, 1.25)).toEqual({
      x: 125,
      y: 63,
      width: 500,
      height: 375,
    });
  });

  it("rounds edges so boxes that touch in CSS still touch on screen", () => {
    const left = toWindowBounds({ x: 0.4, y: 0, width: 300.3, height: 10 }, 1);
    const right = toWindowBounds({ x: 300.7, y: 0, width: 100, height: 10 }, 1);
    expect(left.x + left.width).toBe(right.x);
  });

  it("treats a missing zoom as 100%", () => {
    expect(toWindowBounds(panel, 0)).toEqual(panel);
  });
});
