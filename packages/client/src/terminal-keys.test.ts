import { describe, expect, it } from "vitest";
import { terminalKeyBytes, type TerminalKey } from "./terminal-keys.ts";

const normal = { applicationCursor: false };
const application = { applicationCursor: true };
const bytes = (key: TerminalKey, modes = normal) => terminalKeyBytes(key, modes);

describe("terminal key bytes", () => {
  it("Ctrl with a letter sends its control byte, whatever the letter's case", () => {
    expect(bytes({ key: "c", ctrl: true })).toBe("\x03");
    expect(bytes({ key: "C", ctrl: true })).toBe("\x03");
    expect(bytes({ key: "a", ctrl: true })).toBe("\x01");
    expect(bytes({ key: "z", ctrl: true })).toBe("\x1a");
  });

  it("Ctrl with the classic symbols sends NUL, Esc and the separators", () => {
    expect(bytes({ key: " ", ctrl: true })).toBe("\x00");
    expect(bytes({ key: "@", ctrl: true })).toBe("\x00");
    expect(bytes({ key: "[", ctrl: true })).toBe("\x1b");
    expect(bytes({ key: "\\", ctrl: true })).toBe("\x1c");
    expect(bytes({ key: "]", ctrl: true })).toBe("\x1d");
    expect(bytes({ key: "_", ctrl: true })).toBe("\x1f");
    expect(bytes({ key: "?", ctrl: true })).toBe("\x7f");
  });

  it("Alt sends Esc before the key", () => {
    expect(bytes({ key: "b", alt: true })).toBe("\x1bb");
    expect(bytes({ key: "x", alt: true, ctrl: true })).toBe("\x1b\x18");
    expect(bytes({ key: "Backspace", alt: true })).toBe("\x1b\x7f");
  });

  it("arrows follow the program's cursor key mode", () => {
    expect(bytes({ key: "ArrowUp" })).toBe("\x1b[A");
    expect(bytes({ key: "ArrowLeft" })).toBe("\x1b[D");
    expect(bytes({ key: "ArrowUp" }, application)).toBe("\x1bOA");
    expect(bytes({ key: "ArrowRight" }, application)).toBe("\x1bOC");
    expect(bytes({ key: "Home" }, application)).toBe("\x1bOH");
    expect(bytes({ key: "End" })).toBe("\x1b[F");
  });

  it("modified arrows and paging keys carry xterm's modifier parameter in either mode", () => {
    expect(bytes({ key: "ArrowRight", ctrl: true }, application)).toBe("\x1b[1;5C");
    expect(bytes({ key: "ArrowLeft", alt: true })).toBe("\x1b[1;3D");
    expect(bytes({ key: "ArrowUp", shift: true })).toBe("\x1b[1;2A");
    expect(bytes({ key: "PageUp" })).toBe("\x1b[5~");
    expect(bytes({ key: "PageDown", ctrl: true })).toBe("\x1b[6;5~");
    expect(bytes({ key: "Delete" })).toBe("\x1b[3~");
  });

  it("function keys use SS3 for F1–F4 and tilde codes above", () => {
    expect(bytes({ key: "F1" })).toBe("\x1bOP");
    expect(bytes({ key: "F2", shift: true })).toBe("\x1b[1;2Q");
    expect(bytes({ key: "F5" })).toBe("\x1b[15~");
    expect(bytes({ key: "F12" })).toBe("\x1b[24~");
  });

  it("editing keys send what a shell expects", () => {
    expect(bytes({ key: "Enter" })).toBe("\r");
    expect(bytes({ key: "Tab" })).toBe("\t");
    expect(bytes({ key: "Tab", shift: true })).toBe("\x1b[Z");
    expect(bytes({ key: "Escape" })).toBe("\x1b");
    expect(bytes({ key: "Backspace" })).toBe("\x7f");
    expect(bytes({ key: "Backspace", ctrl: true })).toBe("\x08");
  });

  it("printable keys pass through and bare modifiers send nothing", () => {
    expect(bytes({ key: "|" })).toBe("|");
    expect(bytes({ key: "é" })).toBe("é");
    expect(bytes({ key: "~", shift: true })).toBe("~");
    expect(bytes({ key: "Shift", shift: true })).toBeUndefined();
    expect(bytes({ key: "Control", ctrl: true })).toBeUndefined();
  });
});
