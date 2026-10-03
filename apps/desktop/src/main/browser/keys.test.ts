import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";

describe("Playwright key names for the embedded view", () => {
  it("types a plain character, upper-cased under Shift", () => {
    expect(parseChord("a", "linux")).toEqual({ keyCode: "A", modifiers: [], text: "a" });
    expect(parseChord("Shift+a", "linux")).toEqual({
      keyCode: "A",
      modifiers: ["shift"],
      text: "A",
    });
    expect(parseChord("KeyB", "linux")).toEqual({ keyCode: "B", modifiers: [], text: "b" });
    expect(parseChord("Digit7", "linux")).toMatchObject({ keyCode: "7", text: "7" });
  });

  it("sends named keys under Electron's names without typing text", () => {
    expect(parseChord("ArrowLeft", "linux")).toEqual({ keyCode: "Left", modifiers: [] });
    expect(parseChord("Shift+ArrowDown", "linux")).toEqual({
      keyCode: "Down",
      modifiers: ["shift"],
    });
    expect(parseChord("Enter", "linux")).toEqual({ keyCode: "Enter", modifiers: [] });
    expect(parseChord("F5", "linux")).toEqual({ keyCode: "F5", modifiers: [] });
  });

  it("treats shortcuts as shortcuts, never as typed text", () => {
    expect(parseChord("Control+Shift+t", "linux")).toEqual({
      keyCode: "T",
      modifiers: ["control", "shift"],
    });
    expect(parseChord("Alt+Space", "linux")).toEqual({ keyCode: "Space", modifiers: ["alt"] });
  });

  it("maps ControlOrMeta to Command on macOS and Control elsewhere", () => {
    expect(parseChord("ControlOrMeta+a", "darwin").modifiers).toEqual(["meta"]);
    expect(parseChord("ControlOrMeta+a", "win32").modifiers).toEqual(["control"]);
  });

  it("reads the plus key and the space key", () => {
    expect(parseChord("+", "linux")).toEqual({ keyCode: "Plus", modifiers: [], text: "+" });
    expect(parseChord("Control++", "linux")).toEqual({ keyCode: "Plus", modifiers: ["control"] });
    expect(parseChord(" ", "linux")).toEqual({ keyCode: "Space", modifiers: [], text: " " });
  });

  it("refuses names it does not know rather than pressing something else", () => {
    expect(() => parseChord("Hyper+a", "linux")).toThrow("Unknown modifier");
    expect(() => parseChord("NotAKey", "linux")).toThrow("Unknown key");
  });
});
