import { expect, test } from "vitest";
import { cells, layoutFrame, pickRenderer, quadFloats, type TextLine } from "./layout.ts";

const solid = { u0: 0, v0: 0, u1: 0.01, v1: 0.01 };
const glyph = (char: string) =>
  char === " " ? undefined : { u0: char.charCodeAt(0), v0: 0, u1: 0, v1: 0 };
const metrics = { lineHeight: 20, cellWidth: 10, gutterCells: 0 };
const line = (text: string, band: TextLine["band"] = "none"): TextLine => ({
  gutter: "",
  text,
  band,
  ink: "plain",
});
/** The characters a frame draws, by their atlas position (u0 is the char code here). */
const drawn = (quads: Float32Array, count: number) =>
  Array.from({ length: count }, (_, index) => quads[index * quadFloats + 4] ?? 0)
    .filter((code) => code > 1)
    .map((code) => String.fromCharCode(code))
    .join("");

test("a frame lays out only the lines in view, however long the document", () => {
  const lines = Array.from({ length: 1_000_000 }, (_, n) => line(`L${n}`));
  const frame = layoutFrame(
    lines,
    { scrollTop: 500_000 * 20, scrollLeft: 0, width: 200, height: 60 },
    metrics,
    glyph,
    solid,
  );
  expect(frame.first).toBe(500_000);
  expect(frame.last).toBe(500_003);
  expect(drawn(frame.quads, frame.count)).toBe("L500000L500001L500002");
});

test("long lines are clipped to the visible columns, after horizontal scroll", () => {
  const frame = layoutFrame(
    [line("abcdefghijklmnopqrstuvwxyz")],
    { scrollTop: 0, scrollLeft: 100, width: 40, height: 20 },
    metrics,
    glyph,
    solid,
  );
  expect(drawn(frame.quads, frame.count)).toBe("klmno");
});

test("changed lines get a full-width band under their text", () => {
  const frame = layoutFrame(
    [line("x", "add"), line("y")],
    { scrollTop: 0, scrollLeft: 0, width: 300, height: 40 },
    metrics,
    glyph,
    solid,
  );
  // One band, then two glyphs.
  expect(frame.count).toBe(3);
  expect(frame.quads[2]).toBe(300);
});

test("tabs expand to the next stop of four cells", () => {
  expect(cells("\tx")).toBe("    x");
  expect(cells("ab\tx")).toBe("ab  x");
});

test("the GPU draws only flagged, huge documents, preferring WebGPU, else WebGL2, else DOM", () => {
  const base = { threshold: 5_000, lines: 20_000, enabled: true, webgpu: true, webgl2: true };
  expect(pickRenderer(base)).toBe("webgpu");
  expect(pickRenderer({ ...base, webgpu: false })).toBe("webgl2");
  expect(pickRenderer({ ...base, webgpu: false, webgl2: false })).toBe("dom");
  expect(pickRenderer({ ...base, enabled: false })).toBe("dom");
  expect(pickRenderer({ ...base, lines: 4_999 })).toBe("dom");
});
