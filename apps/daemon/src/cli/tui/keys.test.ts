import { describe, expect, it } from "vitest";
import { decodeKeys } from "./keys.ts";

describe("terminal key decoding", () => {
  it.each([
    ["\x1b[A", { name: "up" }],
    ["\x1b[B", { name: "down" }],
    ["\x1bOC", { name: "right" }],
    ["\x1b[D", { name: "left" }],
    ["\r", { name: "enter" }],
    ["\x1b\r", { name: "enter", alt: true }],
    ["\x7f", { name: "backspace" }],
    ["\x1b", { name: "escape" }],
    ["\x03", { name: "char", text: "c", ctrl: true }],
    ["\x07", { name: "char", text: "g", ctrl: true }],
    ["\x1b[3~", { name: "delete" }],
    ["\x1b[1;5C", { name: "right", ctrl: true }],
    ["\x1b[5~", { name: "pageup" }],
    ["\x1b[Z", { name: "backtab", shift: true }],
    ["\x1bb", { name: "char", text: "b", alt: true }],
  ])("reads %j as one key", (input, key) => {
    expect(decodeKeys(input)).toEqual([key]);
  });

  it("reads typed text one character at a time, keeping emoji whole", () => {
    expect(decodeKeys("y😀é").map((key) => key.text)).toEqual(["y", "😀", "é"]);
  });

  it("keeps a bracketed paste as one key so its newlines never submit", () => {
    expect(decodeKeys("\x1b[200~line one\rline two\x1b[201~\r")).toEqual([
      { name: "paste", text: "line one\rline two" },
      { name: "enter" },
    ]);
  });

  it("reads several keys arriving in one chunk", () => {
    expect(decodeKeys("j\x1b[Bk").map((key) => key.name)).toEqual(["char", "down", "char"]);
  });

  it("reads a CR LF line ending as one Enter", () => {
    expect(decodeKeys("\r\n")).toEqual([{ name: "enter" }]);
  });
});
