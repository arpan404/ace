import { describe, expect, it } from "vitest";
import { agentEmulation, deviceEmulation, PlacementBook, toWindowBounds } from "./placement.ts";

const panel = { x: 920, y: 120, width: 520, height: 780 };
const other = { x: 400, y: 80, width: 600, height: 500 };

describe("embedded view placement", () => {
  it("shows a thread's view where its renderer places it", () => {
    const book = new PlacementBook();
    expect(book.set("t1", 1, { bounds: panel, visible: true })).toEqual({
      host: 1,
      bounds: panel,
      visible: true,
      owner: undefined,
    });
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
    book.set("t1", 1, { bounds: panel, visible: true });
    expect(book.set("t1", 1, { bounds: panel, visible: false })).toEqual({
      host: 1,
      bounds: panel,
      visible: false,
    });
  });

  it("a view hidden under the app's menu stays watched, until it is hidden for real", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    expect(book.set("t1", 1, { bounds: panel, visible: false, covered: true })).toEqual({
      host: 1,
      bounds: panel,
      visible: false,
      covered: true,
    });
    expect(book.set("t1", 1, { bounds: panel, visible: false }).covered).toBeUndefined();
    // Shown in another window meanwhile, it is simply shown there.
    book.set("t1", 1, { bounds: panel, visible: false, covered: true });
    expect(book.set("t1", 2, { bounds: other, visible: true })).toMatchObject({
      host: 2,
      visible: true,
    });
    expect(book.resolve("t1").covered).toBeUndefined();
  });

  it("a view is a picture only while picture-in-picture is where it shows", () => {
    const book = new PlacementBook();
    const pip = { x: 1100, y: 600, width: 320, height: 200 };
    expect(book.set("t1", 1, { bounds: pip, visible: true, picture: true })).toMatchObject({
      host: 1,
      visible: true,
      picture: true,
    });
    // Back in the panel, the page takes the person's clicks again.
    expect(book.set("t1", 1, { bounds: panel, visible: true }).picture).toBeUndefined();
    // Floating in one window but shown in another window's panel since: it's the page there.
    book.set("t1", 1, { bounds: pip, visible: true, picture: true });
    expect(book.set("t1", 2, { bounds: other, visible: true }).picture).toBeUndefined();
    // A hidden floating window is no picture.
    expect(book.set("t1", 3, { bounds: pip, visible: false, picture: true }).picture).toBe(
      undefined,
    );
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
      owner: undefined,
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
      owner: undefined,
    });
  });

  it("forgets a reloaded renderer's placements, so its old box never shows again", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t2", 1, { bounds: other, visible: true });
    book.set("t2", 2, { bounds: panel, visible: false });
    expect(book.forgetHost(1).toSorted()).toEqual(["t1", "t2"]);
    expect(book.resolve("t1").visible).toBe(false);
    expect(book.resolve("t2")).toEqual({
      host: 2,
      bounds: panel,
      visible: false,
    });
  });

  it("keeps nothing of a released claim, unlike a hidden one", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t1", 1, { bounds: panel, visible: false });
    expect(book.resolve("t1").host).toBe(1);
    expect(book.release("t1", 1)).toEqual({
      host: undefined,
      bounds: undefined,
      visible: false,
    });
  });

  it("forgets every claim on a thread whose view is gone", () => {
    const book = new PlacementBook();
    book.set("t1", 1, { bounds: panel, visible: true });
    book.set("t1", 2, { bounds: other, visible: false });
    book.forget("t1");
    expect(book.resolve("t1").host).toBeUndefined();
    expect(book.forgetHost(1)).toEqual([]);
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

// Chromium draws an emulated page `width * scale` DIPs wide; page zoom only changes its CSS.
const drawn = (emulation: { width: number; height: number; scale: number }) => ({
  width: emulation.width * emulation.scale,
  height: emulation.height * emulation.scale,
});

describe("device emulation", () => {
  it("a page shrunk into picture-in-picture fills its box when the app is zoomed", () => {
    const pip = toWindowBounds({ x: 0, y: 0, width: 395, height: 386 }, 1.25);
    const emulation = deviceEmulation({ width: 1040, height: 1016 }, pip, 1.25);
    expect(drawn(emulation).width).toBeCloseTo(pip.width, 5);
    expect(drawn(emulation).height).toBeCloseTo(pip.height, 0);
  });

  it("keeps the panel's layout: the app's zoom maps the emulated size back to the panel's CSS size", () => {
    const emulation = deviceEmulation(
      { width: 1040, height: 1016 },
      { x: 0, y: 0, width: 500, height: 488 },
      1.5,
    );
    expect(emulation.width / 1.5).toBeCloseTo(1040, 0);
    expect(emulation.height / 1.5).toBeCloseTo(1016, 0);
  });

  it("an unzoomed device is emulated at its own size", () => {
    expect(
      deviceEmulation(
        { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
        { x: 0, y: 0, width: 195, height: 422 },
        1,
      ),
    ).toEqual({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true, scale: 0.5 });
  });
});

// Chromium lays out `floor(emulated DIPs / zoom)` CSS pixels and reports `dpr * zoom`.
const laidOut = (emulation: { width: number; height: number }, zoom: number) => ({
  width: Math.floor(emulation.width / zoom),
  height: Math.floor(emulation.height / zoom),
});

describe("an agent's size on a zoomed page", () => {
  const shown = { x: 0, y: 0, width: 1095, height: 684 };

  it("lays the page out at exactly the CSS size asked, whatever the zoom", () => {
    for (const zoom of [1, 1.1, 1.25, 1.316, 1.5, 2])
      expect(laidOut(agentEmulation({ width: 1440, height: 900 }, shown, zoom), zoom)).toEqual({
        width: 1440,
        height: 900,
      });
  });

  it("draws the whole zoomed page inside the panel's box", () => {
    const emulation = agentEmulation({ width: 1440, height: 900 }, shown, 1.316);
    expect(emulation.width * emulation.scale).toBeLessThanOrEqual(shown.width);
    expect(emulation.height * emulation.scale).toBeLessThanOrEqual(shown.height);
  });

  it("never enlarges a device smaller than the panel", () => {
    expect(agentEmulation({ width: 390, height: 600 }, shown, 1).scale).toBe(1);
  });

  it("reports the scale factor the agent asked, and keeps the screen's when it asked none", () => {
    const asked = agentEmulation({ width: 390, height: 844, deviceScaleFactor: 3 }, shown, 1.25);
    expect(asked.deviceScaleFactor * 1.25).toBeCloseTo(3, 10);
    expect(agentEmulation({ width: 800, height: 600 }, shown, 1.25).deviceScaleFactor).toBe(0);
  });

  it("keeps the agent's mobile choice", () => {
    expect(agentEmulation({ width: 390, height: 844, mobile: true }, shown, 1).mobile).toBe(true);
  });
});
