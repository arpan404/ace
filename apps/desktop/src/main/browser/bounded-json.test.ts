import { expect, test } from "vitest";
import { stringifyWithin } from "./bounded-json.ts";

const shapes: [string, unknown][] = [
  ["a flat object", { id: "request-1", type: "browser.backend.response", ok: true }],
  ["small numbers in a long array", { values: Array.from({ length: 500 }, (_, index) => index) }],
  ["empty containers", { a: [], b: {}, c: [[], [{}]] }],
  ["null, booleans and odd numbers", [null, false, true, Number.NaN, -0, 1e21, -1.5]],
  ["dropped entries", { kept: 1, gone: undefined, fn: () => 1, list: [undefined, () => 1] }],
  ["text that needs escaping", { text: 'quote " backslash \\ newline \n tab \t \u0001' }],
  ["multi-byte text", { text: "naïve café 日本語 🙂".repeat(20) }],
  ["values with toJSON", { at: new Date(0), nested: { toJSON: () => ({ a: [1, 2] }) } }],
  ["an empty-string key", { "": "root-like", x: [""] }],
];

test.each(shapes)("%s fits a limit equal to its exact size", (_name, value) => {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  expect(stringifyWithin(value, bytes)).toBe(text);
  expect(stringifyWithin(value, bytes - 1)).toBeUndefined();
});

test("a value that cannot be serialized gives no text instead of throwing", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(stringifyWithin(cycle, 1024)).toBeUndefined();
  expect(stringifyWithin({ big: 1n }, 1024)).toBeUndefined();
});
