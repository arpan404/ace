import { describe, expect, it } from "vitest";
import {
  TouchGestures,
  longPressDelay,
  mouseButton,
  mouseMove,
  type PointerAt,
  type TouchEffect,
} from "./pointer-input.ts";

/** A point on screen; the page is drawn at half size, so page pixels are twice the screen's. */
const at = (x: number, y: number): PointerAt => ({
  screen: { x, y },
  page: { x: x * 2, y: y * 2 },
});
const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const inputs = (effects: TouchEffect[]) =>
  effects.flatMap((effect) => (effect.type === "input" ? [effect.input] : []));
const kinds = (effects: TouchEffect[]) => effects.map((effect) => effect.type);

describe("mouse input", () => {
  it("a shift-click reaches the page with shift held", () => {
    const press = mouseButton(
      "mousePressed",
      { x: 10, y: 20 },
      { ...keys, shiftKey: true, button: 0, buttons: 1, detail: 1 },
    );
    expect(press).toMatchObject({ event: "mousePressed", button: "left", modifiers: 8 });
  });

  it("cmd-click and alt-click carry their keys together", () => {
    const press = mouseButton(
      "mousePressed",
      { x: 0, y: 0 },
      { ...keys, metaKey: true, altKey: true, ctrlKey: true, button: 0, buttons: 1, detail: 1 },
    );
    expect(press).toMatchObject({ modifiers: 1 | 2 | 4 });
  });

  it("a right-button drag moves with the right button held, not as a hover", () => {
    expect(mouseMove({ x: 5, y: 5 }, { ...keys, buttons: 2 })).toMatchObject({
      event: "mouseMoved",
      button: "right",
      buttons: 2,
    });
    expect(mouseMove({ x: 5, y: 5 }, { ...keys, buttons: 4 })).toMatchObject({
      button: "middle",
      buttons: 4,
    });
    expect(mouseMove({ x: 5, y: 5 }, { ...keys, buttons: 0 })).toMatchObject({
      button: "none",
      buttons: 0,
    });
  });

  it("back and forward buttons are not sent as clicks", () => {
    expect(
      mouseButton("mousePressed", { x: 0, y: 0 }, { ...keys, button: 3, buttons: 8, detail: 1 }),
    ).toBeUndefined();
  });

  it("releasing one button reports the others still held", () => {
    expect(
      mouseButton("mouseReleased", { x: 0, y: 0 }, { ...keys, button: 0, buttons: 2, detail: 1 }),
    ).toMatchObject({ button: "left", buttons: 2 });
  });
});

describe("touch gestures", () => {
  it("a quick still touch is a tap at the finger, sent as a touch start and end in page pixels", () => {
    const gestures = new TouchGestures();
    const start = gestures.down(7, at(10, 20), 0);
    expect(inputs(start)).toEqual([
      { kind: "touch", event: "touchStart", points: [{ x: 20, y: 40, id: 0 }] },
    ]);
    const end = gestures.up(7, at(12, 21), 120);
    expect(end).toContainEqual({ type: "tap", at: at(12, 21) });
    expect(inputs(end)).toEqual([{ kind: "touch", event: "touchEnd", points: [] }]);
  });

  it("a one-finger drag pans the view by the finger's movement and is no tap", () => {
    const gestures = new TouchGestures();
    gestures.down(1, at(100, 100), 0);
    // Within the slop it is still a press: nothing pans.
    expect(kinds(gestures.move(1, at(104, 103)))).toEqual(["input"]);
    const moved = gestures.move(1, at(100, 60));
    expect(moved).toContainEqual({
      type: "pan",
      screen: { x: 0, y: -40 },
      page: { x: 0, y: -80 },
    });
    expect(inputs(moved)).toEqual([
      { kind: "touch", event: "touchMove", points: [{ x: 200, y: 120, id: 0 }] },
    ]);
    const next = gestures.move(1, at(100, 50));
    expect(next).toContainEqual({ type: "pan", screen: { x: 0, y: -10 }, page: { x: 0, y: -20 } });
    expect(kinds(gestures.up(1, at(100, 50), 200))).not.toContain("tap");
  });

  it("a pinch sends both fingers on every move and never pans or taps", () => {
    const gestures = new TouchGestures();
    gestures.down(1, at(100, 100), 0);
    const second = gestures.down(2, at(200, 200), 10);
    expect(inputs(second)).toEqual([
      {
        kind: "touch",
        event: "touchStart",
        points: [
          { x: 200, y: 200, id: 0 },
          { x: 400, y: 400, id: 1 },
        ],
      },
    ]);
    const spread = gestures.move(2, at(260, 260));
    expect(kinds(spread)).toEqual(["input"]);
    expect(inputs(spread)[0]).toMatchObject({
      event: "touchMove",
      points: [
        { x: 200, y: 200, id: 0 },
        { x: 520, y: 520, id: 1 },
      ],
    });
    // One finger up: the page sees the other still down; the last one up ends the sequence.
    expect(inputs(gestures.up(1, undefined, 50))).toEqual([
      { kind: "touch", event: "touchMove", points: [{ x: 520, y: 520, id: 1 }] },
    ]);
    const end = gestures.up(2, undefined, 60);
    expect(kinds(end)).toEqual(["input"]);
    expect(inputs(end)).toEqual([{ kind: "touch", event: "touchEnd", points: [] }]);
  });

  it("a finger held still is a long press once, and lifting it is no tap", () => {
    const gestures = new TouchGestures();
    gestures.down(1, at(30, 30), 1000);
    expect(gestures.elapsed(1000 + longPressDelay - 1)).toEqual([]);
    expect(gestures.elapsed(1000 + longPressDelay)).toEqual([
      { type: "longPress", at: at(30, 30) },
    ]);
    expect(gestures.elapsed(1000 + longPressDelay * 2)).toEqual([]);
    expect(kinds(gestures.up(1, at(30, 30), 1000 + longPressDelay + 50))).toEqual(["input"]);
  });

  it("a finger that moved away before the delay is no long press", () => {
    const gestures = new TouchGestures();
    gestures.down(1, at(30, 30), 0);
    gestures.move(1, at(30, 80));
    expect(gestures.elapsed(longPressDelay)).toEqual([]);
  });

  it("a cancelled sequence tells the page and later events of its fingers are ignored", () => {
    const gestures = new TouchGestures();
    gestures.down(1, at(30, 30), 0);
    expect(inputs(gestures.cancel())).toEqual([
      { kind: "touch", event: "touchCancel", points: [] },
    ]);
    expect(gestures.move(1, at(40, 40))).toEqual([]);
    expect(gestures.up(1, at(40, 40), 10)).toEqual([]);
    expect(gestures.cancel()).toEqual([]);
  });

  it("a finger's point id stays with it and a freed id is reused by the next finger", () => {
    const gestures = new TouchGestures();
    gestures.down(11, at(1, 1), 0);
    gestures.down(12, at(2, 2), 0);
    gestures.up(11, undefined, 5);
    const third = gestures.down(13, at(3, 3), 6);
    expect(inputs(third)[0]).toMatchObject({
      points: [
        { x: 4, y: 4, id: 1 },
        { x: 6, y: 6, id: 0 },
      ],
    });
  });

  it("an eleventh finger is not sent: the page takes ten points", () => {
    const gestures = new TouchGestures();
    for (let finger = 0; finger < 10; finger++) gestures.down(finger, at(finger, finger), 0);
    expect(gestures.down(10, at(50, 50), 0)).toEqual([]);
    expect(gestures.active).toBe(10);
  });
});
