import { expect, test } from "vitest";
import { terminalFontFamily } from "./fonts.ts";

const faces = (stack: string) => stack.split(",").map((face) => face.trim().replace(/"/g, ""));

test("the app's monospace face stays first, so only missing glyphs fall through", () => {
  expect(faces(terminalFontFamily('"SF Mono", Menlo, monospace')).slice(0, 2)).toEqual([
    "SF Mono",
    "Menlo",
  ]);
});

test("Nerd Font and system symbol faces come before the generic family", () => {
  const stack = faces(terminalFontFamily('"SF Mono", ui-monospace, Menlo, monospace'));
  const generic = stack.indexOf("ui-monospace");
  expect(stack.indexOf("Symbols Nerd Font Mono")).toBeLessThan(generic);
  expect(stack.indexOf("Apple Symbols")).toBeLessThan(generic);
  expect(stack.at(-1)).toBe("monospace");
});

test("a stack with no generic family still ends in monospace", () => {
  expect(faces(terminalFontFamily("Menlo")).at(-1)).toBe("monospace");
});

test("a Nerd Font the app already names is not listed twice", () => {
  const stack = faces(terminalFontFamily('"MesloLGS NF", monospace'));
  expect(stack.filter((face) => face === "MesloLGS NF")).toHaveLength(1);
});
