import { expect, test } from "vitest";
import { terminalFontFamily } from "./fonts.ts";

const faces = (stack: string) => stack.split(",").map((face) => face.trim().replace(/"/g, ""));

/** Where `face` sits in `stack`, failing the test when it isn't there at all. */
function position(stack: string[], face: string): number {
  expect(stack).toContain(face);
  return stack.indexOf(face);
}

test("the app's monospace faces stay first, so only glyphs they lack fall through", () => {
  expect(faces(terminalFontFamily('"SF Mono", Menlo, monospace')).slice(0, 2)).toEqual([
    "SF Mono",
    "Menlo",
  ]);
});

test("Nerd Font and system symbol faces come after the monospace faces, before the generics", () => {
  const stack = faces(terminalFontFamily('"SF Mono", ui-monospace, Menlo, monospace'));
  const menlo = position(stack, "Menlo");
  const generic = position(stack, "ui-monospace");
  for (const face of [
    "Symbols Nerd Font Mono",
    "JetBrainsMono NF",
    "MesloLGS NF",
    "Apple Symbols",
  ]) {
    const at = position(stack, face);
    expect(at).toBeGreaterThan(menlo);
    expect(at).toBeLessThan(generic);
  }
  expect(stack.at(-1)).toBe("monospace");
});

test("a stack with no generic family still ends in monospace, after the symbol faces", () => {
  const stack = faces(terminalFontFamily("Menlo"));
  expect(position(stack, "Symbols Nerd Font Mono")).toBeLessThan(position(stack, "monospace"));
  expect(stack.at(-1)).toBe("monospace");
});

test("a Nerd Font the app already names stays where it is and isn't listed twice", () => {
  const stack = faces(terminalFontFamily('"MesloLGS NF", monospace'));
  expect(stack[0]).toBe("MesloLGS NF");
  expect(stack.filter((face) => face === "MesloLGS NF")).toHaveLength(1);
  expect(position(stack, "Symbols Nerd Font Mono")).toBeGreaterThan(0);
});
