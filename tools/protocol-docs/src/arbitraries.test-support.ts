/* oxlint-disable eslint/no-underscore-dangle -- Zod exposes typed checks through its _zod API. */
import { z } from "zod";
import * as fc from "fast-check";
import RandExp from "randexp";

function classic(schema: z.core.$ZodType): z.ZodType {
  if (!(schema instanceof z.ZodType)) throw new Error("Non-classic Zod schema");
  return schema;
}

/** Independent Zod traversal: never consult the generated JSON Schema. */
export function arbitrary(root: z.ZodType): fc.Arbitrary<unknown> {
  const cache = new Map<z.ZodType, fc.Arbitrary<unknown>>();
  function cached(schema: z.ZodType): fc.Arbitrary<unknown> {
    const existing = cache.get(schema);
    if (existing) return existing;
    const value = build(schema);
    cache.set(schema, value);
    return value;
  }
  function build(schema: z.ZodType): fc.Arbitrary<unknown> {
    if (schema instanceof z.ZodOptional)
      return fc.oneof(fc.constant(undefined), cached(classic(schema.unwrap())));
    if (schema instanceof z.ZodDefault || schema instanceof z.ZodReadonly)
      return cached(classic(schema.unwrap()));
    if (schema instanceof z.ZodNullable)
      return fc.oneof(fc.constant(null), cached(classic(schema.unwrap())));
    if (schema instanceof z.ZodUnion)
      return fc.oneof(
        ...schema.options.map((part) => {
          if (!(part instanceof z.ZodType)) throw new Error("Non-classic Zod union");
          return cached(part);
        }),
      );
    if (schema instanceof z.ZodIntersection) {
      return fc
        .tuple(cached(classic(schema.def.left)), cached(classic(schema.def.right)))
        .map(([a, b]) => {
          if (typeof a === "string" && typeof b === "string") return a.length > b.length ? a : b;
          return Object.assign({}, typeof a === "object" ? a : {}, typeof b === "object" ? b : {});
        });
    }
    if (schema instanceof z.ZodLiteral) return fc.constantFrom(...schema.values);
    if (schema instanceof z.ZodEnum) return fc.constantFrom(...schema.options);
    if (schema instanceof z.ZodBoolean) return fc.boolean();
    if (schema instanceof z.ZodNull) return fc.constant(null);
    if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny)
      return fc.jsonValue({ maxDepth: 2 });
    if (schema instanceof z.ZodNumber) {
      return fc
        .integer({
          min: Math.max(0, Math.ceil(schema.minValue ?? 0)),
          max: Math.min(10000, Math.floor(schema.maxValue ?? 10000)),
        })
        .filter((value) => schema.safeParse(value).success);
    }
    if (schema instanceof z.ZodString || schema instanceof z.ZodStringFormat) {
      if (String(schema.meta()?.["x-ace-constraint"]).includes("IANA"))
        return fc.constantFrom("UTC", "America/Chicago", "Europe/London");
      const pattern = schema._zod.def.checks
        ?.map((check) => check._zod.def)
        .find((check) => "pattern" in check && check.pattern instanceof RegExp);
      if (pattern && "pattern" in pattern && pattern.pattern instanceof RegExp) {
        const expression = pattern.pattern;
        return fc
          .integer()
          .map((seed) => {
            const generator = new RandExp(expression);
            generator.max = 16;
            let state = seed;
            generator.randInt = (min, max) => {
              state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
              return min + (state % (max - min + 1));
            };
            return generator.gen();
          })
          .filter((value) => schema.safeParse(value).success);
      }
      if (schema.format === "url")
        return fc
          .integer({ min: 0, max: 10000 })
          .map((id) => `https://host${id}.example.invalid/path/${id}`);
      return fc.string({
        minLength: schema.minLength ?? 0,
        maxLength: Math.min(schema.maxLength ?? 20, Math.max(20, schema.minLength ?? 0)),
      });
    }
    if (schema instanceof z.ZodArray) {
      const element = schema.element;
      if (!(element instanceof z.ZodType)) throw new Error("Non-classic Zod array");
      const constraints = schema._zod.def.checks?.map((check) => check._zod.def) ?? [];
      const lower = constraints
        .filter((check) => check.check === "min_length")
        .map((check) => ("minimum" in check ? Number(check.minimum) : 0));
      const upper = constraints
        .filter((check) => check.check === "max_length")
        .map((check) => ("maximum" in check ? Number(check.maximum) : 2));
      const min = Math.max(0, ...lower);
      const max = Math.min(2, ...upper);
      return fc.array(cached(element), {
        minLength: Number(min),
        maxLength: Math.max(Number(min), Math.min(Number(max), 2)),
      });
    }
    if (schema instanceof z.ZodRecord) {
      if (!(schema.valueType instanceof z.ZodType)) throw new Error("Non-classic Zod record");
      return fc.dictionary(
        cached(classic(schema.keyType)).map((key) => {
          if (typeof key !== "string") throw new Error("Non-string record key");
          return key;
        }),
        cached(schema.valueType),
        { maxKeys: 2 },
      );
    }
    if (schema instanceof z.ZodObject) {
      const fields: Record<string, fc.Arbitrary<unknown>> = {};
      for (const [key, child] of Object.entries(schema.shape)) {
        if (!(child instanceof z.ZodType)) throw new Error("Non-classic Zod object");
        fields[key] = cached(child);
      }
      return fc
        .record(fields)
        .map((value) =>
          Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)),
        );
    }
    throw new Error(`No arbitrary for ${schema.type}`);
  }
  return cached(root);
}
