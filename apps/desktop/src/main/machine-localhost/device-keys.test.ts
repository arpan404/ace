import { describe, expect, it } from "vitest";
import { deviceTabKey, zoomedLevel } from "./device-keys.ts";

const key = (code: string, keyName: string, held: { control?: boolean; meta?: boolean } = {}) => ({
  type: "keyDown",
  key: keyName,
  code,
  shift: false,
  alt: false,
  control: held.control ?? false,
  meta: held.meta ?? false,
});

describe("a key pressed in a device tab", () => {
  it.each([
    [
      "Ctrl+L moves typing to the address",
      key("KeyL", "l", { control: true }),
      { kind: "address" },
    ],
    ["Ctrl+R reloads the page", key("KeyR", "r", { control: true }), { kind: "reload" }],
    ["Ctrl+[ goes back", key("BracketLeft", "[", { control: true }), { kind: "back" }],
    ["Ctrl+= zooms the page in", key("Equal", "=", { control: true }), { kind: "zoomIn" }],
    ["Ctrl+P prints the page", key("KeyP", "p", { control: true }), { kind: "print" }],
    [
      "Ctrl+K opens the app's palette",
      key("KeyK", "k", { control: true }),
      { kind: "app", accelerator: "CmdOrCtrl+K" },
    ],
    ["Ctrl+F stays the page's", key("KeyF", "f", { control: true }), undefined],
    ["a letter is typed into the page", key("KeyA", "a"), undefined],
  ])("on Linux, %s", (_name, input, meaning) => {
    expect(deviceTabKey(input, "linux")).toEqual(meaning);
  });

  it("uses Command on a Mac, where Ctrl+L is the page's", () => {
    expect(deviceTabKey(key("KeyL", "l", { meta: true }), "darwin")).toEqual({ kind: "address" });
    expect(deviceTabKey(key("KeyL", "l", { control: true }), "darwin")).toBeUndefined();
  });
});

describe("a device tab's zoom", () => {
  it("steps a level at a time, within bounds, and resets to 100%", () => {
    expect(zoomedLevel(0, "zoomIn")).toBe(1);
    expect(zoomedLevel(1, "zoomOut")).toBe(0);
    expect(zoomedLevel(5, "zoomIn")).toBe(5);
    expect(zoomedLevel(-5, "zoomOut")).toBe(-5);
    expect(zoomedLevel(3, "zoomReset")).toBe(0);
  });
});
