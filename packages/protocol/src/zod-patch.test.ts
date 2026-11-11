import { expect, test } from "vitest";
import { z } from "zod";

// ace patches Zod 4.6.7 (patches/zod@4.6.7.patch) so schemas of one type share their traits set
// and their JSON Schema processor instead of each carrying its own: the daemon builds about
// 35,000 schemas at startup, and those copies were about a fifth of its idle heap.

test.skipIf(!process.versions.bun)(
  "a small object schema costs at most 2.6 KB of heap (about 3.6 KB without the patch)",
  async () => {
    const { heapStats } = await import("bun:jsc");
    const heap = () => {
      Bun.gc(true);
      return heapStats().heapSize;
    };
    const costs: number[] = [];
    for (let round = 0; round < 3; round++) {
      const before = heap();
      const schemas = Array.from({ length: 2000 }, () =>
        z.object({ a: z.string(), b: z.number() }),
      );
      costs.push((heap() - before) / schemas.length);
    }
    expect(Math.min(...costs)).toBeLessThan(2600);
  },
);

test("a trait added to one built schema is not added to another schema of the same type", () => {
  const first = z.string();
  const second = z.string();
  const Marker = z.core.$constructor("AceMarker", () => {});
  Marker.init(first, first._zod.def);
  expect(first instanceof Marker).toBe(true);
  expect(second instanceof Marker).toBe(false);
  expect(z.string() instanceof Marker).toBe(false);
});

test("schemas still recognise their own types and no other", () => {
  expect(z.string() instanceof z.ZodString).toBe(true);
  expect(z.string() instanceof z.ZodNumber).toBe(false);
  expect(z.email() instanceof z.ZodStringFormat).toBe(true);
  expect(z.string().email() instanceof z.ZodString).toBe(true);
  expect(z.number().int() instanceof z.ZodNumber).toBe(true);
});

test("JSON Schema output is unchanged by the shared processors", () => {
  const schema = z.object({
    name: z.string().min(1).max(40),
    count: z.number().int().optional(),
    kind: z.enum(["a", "b"]),
    tags: z.array(z.string()).default([]),
  });
  expect(z.toJSONSchema(schema)).toEqual({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 40 },
      count: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
      kind: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, default: [] },
    },
    required: ["name", "kind", "tags"],
    additionalProperties: false,
  });
});
