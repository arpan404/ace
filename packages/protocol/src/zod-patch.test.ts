import { afterEach, expect, test } from "vitest";
import { z } from "zod";

// ace patches Zod 4.6.7 (patches/zod@4.6.7.patch, made by scripts/patch-zod.ts): schemas are
// built on first use, schemas of one type share their traits set and JSON Schema processor.
// The daemon defines about 35,000 schemas and uses few of them, and their internals were most
// of its idle heap. These tests hold the memory gain and check that a schema built lazily
// behaves exactly like one built at once (`z.config({ eagerSchemas: true })` builds at once).

afterEach(() => {
  z.config({ eagerSchemas: false } as Parameters<typeof z.config>[0]);
});
function eager<T>(define: () => T): T {
  z.config({ eagerSchemas: true } as Parameters<typeof z.config>[0]);
  try {
    return define();
  } finally {
    z.config({ eagerSchemas: false } as Parameters<typeof z.config>[0]);
  }
}
const define = () =>
  z.object({
    id: z.string().min(1).max(40).describe("the id"),
    count: z.number().int().nonnegative().optional(),
    kind: z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), value: z.string() }),
      z.object({ type: z.literal("b"), items: z.array(z.string()).default([]) }),
    ]),
    tags: z.record(z.string(), z.boolean()).meta({ title: "Tags" }),
  });
const inputs: unknown[] = [
  { id: "x", kind: { type: "a", value: "v" }, tags: {} },
  { id: "x", count: 2, kind: { type: "b" }, tags: { t: true } },
  { id: "", kind: { type: "a", value: 1 }, tags: { t: "no" } },
  { id: "y".repeat(41), count: -1.5, kind: { type: "c" }, tags: null },
  "not an object",
];

test.skipIf(!process.versions.bun)(
  "a small object schema nothing has used costs under 1 KB of heap (3.6 KB with stock Zod)",
  () => {
    // Bun's own API, reached without Bun's type declarations (the package checks against Node's).
    const bun: unknown = Reflect.get(globalThis, "Bun");
    const gc: unknown =
      typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
    if (typeof gc !== "function") throw new Error("Bun.gc is unavailable");
    const heap = () => {
      Reflect.apply(gc, bun, [true]);
      return process.memoryUsage().heapUsed;
    };
    z.object({ a: z.string(), b: z.number() });
    const costs: number[] = [];
    for (let round = 0; round < 3; round++) {
      const before = heap();
      const schemas = Array.from({ length: 2000 }, () =>
        z.object({ a: z.string(), b: z.number() }),
      );
      costs.push((heap() - before) / schemas.length);
    }
    expect(Math.min(...costs)).toBeLessThan(1024);
  },
);

test("a lazily built schema parses, fails and reports issues exactly like an eager one", () => {
  const lazy = define();
  const built = eager(define);
  for (const input of inputs) {
    const a = lazy.safeParse(input);
    const b = built.safeParse(input);
    expect(a.success).toBe(b.success);
    expect(a.data).toEqual(b.data);
    expect(a.error?.issues).toEqual(b.error?.issues);
  }
});

test("a lazily built schema prints the same JSON Schema and JSON as an eager one", () => {
  const lazy = define();
  const built = eager(define);
  expect(z.toJSONSchema(lazy)).toEqual(z.toJSONSchema(built));
  expect(JSON.stringify(define())).toBe(JSON.stringify(eager(define)));
  expect(Object.keys(lazy.shape)).toEqual(Object.keys(built.shape));
});

test("descriptions and metadata survive lazy copies", () => {
  const schema = define();
  expect(schema.shape.id.description).toBe("the id");
  expect(schema.shape.tags.meta()).toEqual({ title: "Tags" });
  expect(z.string().describe("later").optional().unwrap().description).toBe("later");
});

test("schemas still recognise their own types and no other", () => {
  expect(z.string() instanceof z.ZodString).toBe(true);
  expect(z.string() instanceof z.ZodNumber).toBe(false);
  expect(z.email() instanceof z.ZodStringFormat).toBe(true);
  expect(z.string().email() instanceof z.ZodString).toBe(true);
  expect(z.number().int().optional().unwrap() instanceof z.ZodNumber).toBe(true);
});

test("a discriminated union with an option missing its discriminator still fails when defined", () => {
  expect(() =>
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("a") }),
      z.object({ other: z.string() }),
    ]),
  ).toThrow('Invalid discriminated union option at index "1"');
});

test("a trait added to one built schema is not added to another schema of the same type", () => {
  const first = z.string();
  const second = z.string();
  const Marker: z.core.$constructor<z.core.$ZodType> = z.core.$constructor("AceMarker", () => {});
  Marker.init(first, first.def);
  expect(first instanceof Marker).toBe(true);
  expect(second instanceof Marker).toBe(false);
  expect(z.string() instanceof Marker).toBe(false);
});
