import { expect, it } from "vitest";
import { parseUITree, parseUIFind } from "./ui-results.ts";
const node = {
  ref: "save",
  role: "button",
  name: "Save",
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  states: [],
  actions: ["press"],
  children: [],
};
it("UI replies reject aggregate node counts and excessive depth before recursive decoding", () => {
  expect(parseUITree({ root: node, truncated: true }, 1, 0)).toMatchObject({
    root: { ref: "save" },
    truncated: true,
  });
  expect(() =>
    parseUITree({ root: { ...node, children: [node, node] }, truncated: false }, 2, 5),
  ).toThrow("caps");
  expect(() =>
    parseUITree({ root: { ...node, children: [node] }, truncated: false }, 2, 0),
  ).toThrow("caps");
  expect(() =>
    parseUIFind({ nodes: [{ ...node, children: [node] }], truncated: false }, 2),
  ).toThrow("caps");
  expect(() => parseUIFind({ nodes: [node, node], truncated: false }, 1)).toThrow();
  expect(() =>
    parseUITree({ root: { ...node, states: ["invented"] }, truncated: false }, 1, 0),
  ).toThrow();
});
