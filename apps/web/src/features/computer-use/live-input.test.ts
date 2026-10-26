import { expect, test } from "vitest";
import { keyInput, pointerGesture, windowPoint } from "./live-input.ts";

const keys = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

test("a click on a letterboxed live view lands on the same spot of the window, in its points", () => {
  // An 800×400 picture of a 2× window, drawn in a 400×400 box: 400×200 tall, centred.
  const shown = {
    box: { left: 10, top: 20, width: 400, height: 400 },
    width: 800,
    height: 400,
    scale: 2,
  };
  expect(windowPoint({ x: 10 + 200, y: 20 + 100 + 100 }, shown)).toEqual({ x: 200, y: 100 });
  expect(windowPoint({ x: 10, y: 20 + 100 }, shown)).toEqual({ x: 0, y: 0 });
  // The bars above and below the picture aren't the window.
  expect(windowPoint({ x: 200, y: 30 }, shown)).toBeUndefined();
  expect(windowPoint({ x: 200, y: 20 + 390 }, shown)).toBeUndefined();
});

test("a press and release in place is a click; moved, it is a drag to where it ended", () => {
  const down = { page: { x: 5, y: 5 }, at: { x: 50, y: 60 }, button: 0 };
  expect(pointerGesture(down, { page: { x: 7, y: 6 }, at: { x: 51, y: 60 } }, 80)).toEqual({
    kind: "pointer.click",
    x: 50,
    y: 60,
    button: "left",
  });
  expect(
    pointerGesture({ ...down, button: 2 }, { page: { x: 5, y: 5 }, at: undefined }, 80),
  ).toEqual({ kind: "pointer.click", x: 50, y: 60, button: "right" });
  expect(pointerGesture(down, { page: { x: 60, y: 5 }, at: { x: 120, y: 60 } }, 350)).toEqual({
    kind: "pointer.drag",
    x: 50,
    y: 60,
    toX: 120,
    toY: 60,
    button: "left",
    durationMs: 350,
  });
});

test("typed characters are text and named keys and shortcuts are key presses", () => {
  expect(keyInput({ ...keys, key: "é" })).toEqual({ kind: "text.type", text: "é" });
  expect(keyInput({ ...keys, key: "A", shiftKey: true })).toEqual({ kind: "text.type", text: "A" });
  expect(keyInput({ ...keys, key: "ArrowLeft", shiftKey: true })).toEqual({
    kind: "key.press",
    key: "Left",
    modifiers: ["shift"],
  });
  expect(keyInput({ ...keys, key: "a", ctrlKey: true })).toEqual({
    kind: "key.press",
    key: "a",
    modifiers: ["control"],
  });
  expect(keyInput({ ...keys, key: "Shift", shiftKey: true })).toBeUndefined();
});
