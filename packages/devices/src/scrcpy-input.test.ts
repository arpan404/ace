import { describe, expect, it } from "vitest";
import { HeldPointers, scrcpyInputPlan } from "./scrcpy-input.ts";

const display = { width: 1080, height: 2400 };
const video = { width: 540, height: 1200 };
let sequence = 0n;
const plan = (input: Parameters<typeof scrcpyInputPlan>[0]) =>
  scrcpyInputPlan(input, display, video, () => ++sequence);

describe("Android input over the scrcpy control socket", () => {
  it("a tap is a finger down and up at the point scaled into the video frame", () => {
    expect(plan({ kind: "tap", x: 100, y: 2000 })).toEqual([
      {
        delayMs: 0,
        message: {
          type: "touch",
          action: "down",
          pointerId: 0n,
          x: 50,
          y: 1000,
          screen: video,
          pressure: 1,
        },
      },
      {
        delayMs: 0,
        message: {
          type: "touch",
          action: "up",
          pointerId: 0n,
          x: 50,
          y: 1000,
          screen: video,
          pressure: 0,
        },
      },
    ]);
  });

  it("each finger keeps its own pointer id so two fingers can pinch", () => {
    const first = plan({ kind: "pointer", phase: "down", x: 500, y: 1000 });
    const second = plan({ kind: "pointer", phase: "down", x: 500, y: 1400, pointerId: 1 });
    expect(first[0]?.message).toMatchObject({ action: "down", pointerId: 0n });
    expect(second[0]?.message).toMatchObject({ action: "down", pointerId: 1n, y: 700 });
  });

  it("a long press holds the finger for its duration before lifting", () => {
    const steps = plan({ kind: "longPress", x: 10, y: 10, durationMs: 800 });
    expect(
      steps.map((step) => [step.message.type === "touch" && step.message.action, step.delayMs]),
    ).toEqual([
      ["down", 0],
      ["up", 800],
    ]);
  });

  it("a swipe moves about once per display frame and spends its whole duration moving", () => {
    const steps = plan({ kind: "swipe", x: 0, y: 2000, toX: 0, toY: 400, durationMs: 160 });
    const moves = steps.filter(
      (step) => step.message.type === "touch" && step.message.action === "move",
    );
    expect(moves).toHaveLength(10);
    expect(moves.reduce((total, step) => total + step.delayMs, 0)).toBeCloseTo(160);
    expect(steps.at(-1)?.message).toMatchObject({ action: "up", x: 0, y: 200 });
  });

  it("plain ASCII is injected as text in chunks the server accepts", () => {
    const steps = plan({ kind: "type", text: "a".repeat(650) });
    expect(steps.map((step) => step.message.type === "text" && step.message.text.length)).toEqual([
      300, 300, 50,
    ]);
  });

  it("text the keyboard map cannot type (accents, emoji) is pasted through the clipboard", () => {
    const steps = plan({ kind: "type", text: "héllo 👋" });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.message).toMatchObject({
      type: "setClipboard",
      text: "héllo 👋",
      paste: true,
    });
  });

  it("keys map to navigation and system actions", () => {
    const first = (key: "home" | "back" | "rotate" | "enter" | "power" | "recents") =>
      plan({ kind: "key", key })[0]?.message;
    expect(first("home")).toMatchObject({ type: "keycode", keycode: 3 });
    expect(first("recents")).toMatchObject({ type: "keycode", keycode: 187 });
    expect(first("power")).toMatchObject({ type: "keycode", keycode: 26 });
    expect(first("enter")).toMatchObject({ type: "keycode", keycode: 66 });
    expect(first("back")).toMatchObject({ type: "backOrScreenOn" });
    expect(first("rotate")).toEqual({ type: "rotate" });
  });

  it("refuses a point outside the screen instead of injecting it at the edge", () => {
    expect(() => plan({ kind: "tap", x: 1080, y: 10 })).toThrow("outside the device screen");
  });

  it("fingers still held when control moves on are lifted where they were last seen", () => {
    const held = new HeldPointers();
    held.apply({ kind: "pointer", phase: "down", x: 1, y: 2 });
    held.apply({ kind: "pointer", phase: "down", x: 3, y: 4, pointerId: 1 });
    held.apply({ kind: "pointer", phase: "move", x: 5, y: 6, pointerId: 1 });
    held.apply({ kind: "pointer", phase: "up", x: 1, y: 2 });
    expect(held.release()).toEqual([{ kind: "pointer", phase: "up", x: 5, y: 6, pointerId: 1 }]);
    expect(held.release()).toEqual([]);
  });
});
