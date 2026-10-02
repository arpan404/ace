import RandExp from "randexp";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { z } from "zod";
import { nodes, object, resolve, strings, type JsonSchema, type Snapshot } from "./model.ts";

export type Random = () => number;
export function seededRandom(seed: number): Random {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function pick<T>(values: readonly T[], random: Random): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("Cannot choose from an empty schema");
  return value;
}
export function candidate(
  schema: JsonSchema,
  schemas: Snapshot["schemas"],
  random: Random,
  depth = 0,
): unknown {
  if (depth > 32) throw new Error("Example exceeds schema depth 32");
  const node = resolve(schema, schemas);
  if ("const" in node) return node.const;
  if (node.enum) return pick(node.enum, random);
  const choices = node.anyOf ?? node.oneOf;
  if (choices) return candidate(pick(choices, random), schemas, random, depth + 1);
  if (node.allOf) {
    const values = node.allOf.map((part) => candidate(part, schemas, random, depth + 1));
    if (values.every((value) => typeof value === "string"))
      return values.reduce<string>(
        (longest, value) =>
          typeof value === "string" && value.length > longest.length ? value : longest,
        "",
      );
    return Object.assign({}, ...values.filter((value) => typeof value === "object"));
  }
  const type = Array.isArray(node.type) ? pick(node.type, random) : node.type;
  if (type === "null") return null;
  if (type === "boolean") return random() < 0.5;
  if (type === "number" || type === "integer") {
    const lower = Math.max(
      node.minimum ?? 0,
      typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum + 1 : 0,
    );
    const upper = Math.min(
      node.maximum ?? lower + 10,
      typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum - 1 : lower + 10,
    );
    const step = node.multipleOf ?? 1;
    return (
      Math.ceil(lower / step) * step +
      Math.floor(random() * Math.max(1, Math.min(10, (upper - lower) / step + 1))) * step
    );
  }
  if (type === "string") {
    if (node["x-ace-constraint"] && String(node["x-ace-constraint"]).includes("IANA")) return "UTC";
    if (node.pattern) {
      const generator = new RandExp(node.pattern);
      generator.max = 10;
      generator.randInt = (from, to) => from + Math.floor(random() * (to - from + 1));
      return generator.gen();
    }
    if (node.format === "uri" || node.format === "url") return "https://example.invalid/";
    if (node.format === "date-time") return "2026-10-02T00:00:00Z";
    if (node.format === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (node.format === "email") return "client@example.invalid";
    return "example".slice(0, node.maxLength ?? 7).padEnd(node.minLength ?? 0, "x");
  }
  if (type === "array") {
    return Array.from({ length: node.minItems ?? 0 }, () =>
      candidate(object(node.items), schemas, random, depth + 1),
    );
  }
  if (type === "object" || node.properties) {
    const result: Record<string, unknown> = {};
    const required = strings(node.required);
    for (const [key, value] of Object.entries(object(node.properties))) {
      if (required.includes(key) || random() < 0.35)
        result[key] = candidate(object(value), schemas, random, depth + 1);
    }
    return result;
  }
  return null;
}

export function jsonValidator(snapshot: Snapshot): Ajv2020 {
  const validator = new Ajv2020({ strict: false, validateFormats: true });
  addFormats.default(validator);
  for (const schema of Object.values(snapshot.schemas)) validator.addSchema(schema);
  return validator;
}
export function validExample(
  name: string,
  source: z.ZodType,
  schema: JsonSchema,
  snapshot: Snapshot,
  random: Random,
  validator: Ajv2020,
): unknown {
  const validate = validator.compile(schema);
  for (let attempt = 0; attempt < 256; attempt++) {
    const value = candidate(schema, snapshot.schemas, random);
    if (source.safeParse(value).success && validate(value)) return value;
  }
  throw new Error(`Schema ${name}: no valid example after 256 attempts`);
}
export function variants(schema: JsonSchema, snapshot: Snapshot): JsonSchema[] {
  const node = resolve(schema, snapshot.schemas);
  return nodes(node.anyOf ?? node.oneOf).length ? nodes(node.anyOf ?? node.oneOf) : [schema];
}
