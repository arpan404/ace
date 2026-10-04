import { describe, expect, it } from "vitest";
import { PlacementBook, toWindowBounds } from "./placement.ts";

const panel = { x: 920, y: 120, width: 520, height: 780 };
const other = { x: 400, y: 80, width: 600, height: 500 };

describe("embedded view placement", () => {
  it("shows a thread's view where its renderer places it", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, { bounds: panel, visible: true })).toEqual({
      host: 1,
      bounds: panel,
      visible: true,
      input: false,
    });
  });

  it("stays hidden until a renderer has placed it", () => {
    expect(new PlacementBook().resolve("t1")).toEqual({
      host: undefined,
      bounds: undefined,
      visible: false,
      input: false,
    });
  });

  it("hides the view when its tab stops showing, keeping its window and box", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    expect(book.set("t1", 1, { bounds: panel, visible: false })).toEqual({
      host: 1,
      bounds: panel,
      visible: false,
      input: false,
    });
  });

  it("never shows a view in an empty box (a collapsed panel)", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, { bounds: { ...panel, width: 0 }, visible: true }).visible).toBe(
      false,
    );
  });

  it("moves the view to the window that showed it most recently", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    expect(book.set("t1", 2, { bounds: other, visible: true })).toEqual({
      host: 2,
      bounds: other,
      visible: true,
      input: false,
    });
  });

  it("keeps the view showing in one window when another window hides its tab", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t1", 2, { bounds: other, visible: true });
    expect(book.set("t1", 2, { bounds: other, visible: false })).toEqual({
      host: 1,
      bounds: panel,
      visible: true,
      input: false,
    });
  });

  it("forgets a reloaded renderer's placements, so its old box never shows again", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t2", 1, { bounds: other, visible: true });
    book.set("t2", 2, { bounds: panel, visible: false });
    expect(book.forgetHost(1).toSorted()).toEqual(["t1", "t2"]);
    expect(book.resolve("t1").visible).toBe(false);
    expect(book.resolve("t2")).toEqual({ host: 2, bounds: panel, visible: false, input: false });
  });

  it("lets the person's input through only where a renderer holding control shows the view", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, { bounds: panel, visible: true, input: true }).input).toBe(true);
    // Hidden, the view takes no input, whoever holds control.
    expect(book.set("t1", 1, { bounds: panel, visible: false, input: true }).input).toBe(false);
    // Another window shows it without control: its clicks ask for control instead.
    book.set("t1", 1, { bounds: panel, visible: true, input: true });
    expect(book.set("t1", 2, { bounds: other, visible: true, input: false }).input).toBe(false);
  });

  it("keeps thread views apart", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t2", 1, { bounds: other, visible: false });
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
