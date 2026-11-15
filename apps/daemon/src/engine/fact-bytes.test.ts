import { expect, it } from "vitest";
import { streamedFactsBytes } from "./fact-bytes.ts";

const delta = (append: string, extra: object = {}) => ({
  type: "item.delta",
  agent: "root",
  item: "message",
  field: "text",
  append,
  ...extra,
});
it.each([
  ["no facts", []],
  ["a signal with and without an agent", [{ type: "signal" }, { type: "signal", agent: "root" }]],
  ["plain text", [delta("hello world")]],
  ["escapes and controls", [delta('"quoted"\\path\n\t\u0001\u001f\u007f')]],
  ["multi-byte characters", [delta("é€😀 中文")]],
  ["lone surrogates", [delta("a\ud800b\udc00"), delta("\ud83d")]],
  ["an absent optional field", [delta("x", { agent: undefined })]],
  ["a non-string field", [delta("x", { at: 12.5, done: true, meta: { n: [1, "é"] } })]],
  [
    "fields serialised as nothing or as null",
    [delta("x", { skip: { toJSON: () => undefined }, none: null, nan: Number.NaN, run: () => 1 })],
  ],
  [
    "a field serialised through toJSON",
    [delta("x", { at: new Date(0), id: { toJSON: () => "é" } })],
  ],
  ["a large batch", Array.from({ length: 256 }, (_, n) => delta(`chunk ${n} `.repeat(n % 9)))],
])("measures %s exactly as their JSON", (_name, facts) => {
  expect(streamedFactsBytes(facts)).toBe(Buffer.byteLength(JSON.stringify(facts)));
});
