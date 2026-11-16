import { expect, test } from "vitest";
import { inspectSuit, plan, type SuitEntry } from "./folder.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const problemsOf = (fields: Record<string, unknown>) => {
  const text = JSON.stringify({ format: 1, id: "neon", name: "Neon", ...fields });
  const map = new Map([["suit.json", bytes(text)]]);
  const entries: SuitEntry[] = [{ path: "suit.json", kind: "file", size: text.length }];
  return inspectSuit("neon", map, plan(entries)).summary.problems;
};

test("terminal text too close to the terminal's background is a contrast problem at its field", () => {
  const problems = problemsOf({
    dark: { canvas: "#101014" },
    terminal: { dark: { background: "#202020", foreground: "#3A3A3A" } },
  });
  expect(problems).toEqual([
    expect.objectContaining({
      check: "contrast",
      field: "terminal.dark.foreground",
      scheme: "dark",
      message: expect.stringContaining("terminal"),
    }),
  ]);
});

test("a terminal background alone is held against the Suit's own text colour", () => {
  const problems = problemsOf({
    light: { text: "#202020" },
    terminal: { light: { background: "#303030" } },
  });
  expect(problems).toEqual([
    expect.objectContaining({ check: "contrast", field: "terminal.light.background" }),
  ]);
});

test("readable terminal colours, and colours for a scheme the Suit lacks, pass", () => {
  expect(
    problemsOf({
      dark: { canvas: "#101014" },
      terminal: {
        dark: { background: "#0B0B10ee", foreground: "#E0E0E0" },
        light: { background: "#FFFFFF", foreground: "#FAFAFA" },
      },
    }),
  ).toEqual([]);
});
