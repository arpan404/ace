import { expect, it } from "vitest";
import { FocusHandoff, type HandoffInput } from "./focus-handoff.ts";

const key = (type: "keyDown" | "keyUp", value: string, shift = false): HandoffInput => ({
  type,
  key: value,
  shift,
  control: false,
  alt: false,
  meta: false,
});

it("keys typed right after ⌘L are kept and replayed as typed text, in order", () => {
  const handoff = new FocusHandoff();
  handoff.start(1_000, 1_000);
  expect(handoff.capture(1_010, key("keyDown", "g"))).toBe(true);
  expect(handoff.capture(1_020, key("keyUp", "g"))).toBe(true);
  expect(handoff.capture(1_030, key("keyDown", "O", true))).toBe(true);
  expect(handoff.take()).toEqual([
    { type: "keyDown", keyCode: "G", modifiers: [] },
    { type: "char", keyCode: "g", modifiers: [] },
    { type: "keyUp", keyCode: "G", modifiers: [] },
    { type: "keyDown", keyCode: "O", modifiers: ["shift"] },
    { type: "char", keyCode: "O", modifiers: ["shift"] },
  ]);
});

it("once the field has the keys, typing reaches the page again", () => {
  const handoff = new FocusHandoff();
  handoff.start(0, 1_000);
  handoff.capture(10, key("keyDown", "a"));
  handoff.take();
  expect(handoff.capture(20, key("keyDown", "b"))).toBe(false);
});

it("a handoff nobody completes lets go of the keyboard after its deadline", () => {
  const handoff = new FocusHandoff();
  handoff.start(0, 1_000);
  expect(handoff.capture(1_001, key("keyDown", "a"))).toBe(false);
  expect(handoff.take()).toEqual([]);
});

it("named keys replay as keys, without typing their names", () => {
  const handoff = new FocusHandoff();
  handoff.start(0, 1_000);
  handoff.capture(1, key("keyDown", "Backspace"));
  handoff.capture(2, key("keyDown", "ArrowLeft"));
  handoff.capture(3, key("keyDown", " "));
  expect(handoff.take()).toEqual([
    { type: "keyDown", keyCode: "Backspace", modifiers: [] },
    { type: "keyDown", keyCode: "Left", modifiers: [] },
    { type: "keyDown", keyCode: "Space", modifiers: [] },
    { type: "char", keyCode: " ", modifiers: [] },
  ]);
});
