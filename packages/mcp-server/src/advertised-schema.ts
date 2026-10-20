import { flatUnion } from "./schema-unions.ts";

/**
 * The schemas a model reads. Upfront-loading clients (OpenCode, Cursor, Pi, ACP) resend every
 * tool's input schema on every request, and Codex reads output schemas, so keywords that only
 * bound values a model never approaches are dropped here: the `$schema` dialect, string
 * lengths, the safe-integer range and `additionalProperties: false` (models send the properties
 * they are shown, and an output open to extra keys accepts ace's reserved result keys). ace's
 * own `x-ace-constraint` notes are dropped too: each rule is enforced by the Zod schema and
 * named in the `invalid_arguments` issue a call that breaks it gets, and the fields' own
 * descriptions say which action needs them. Unions of string choices and discriminated object
 * unions are spelled flat (`schema-unions.ts`).
 *
 * The registry still validates each call against the full Zod schema, and a call that crosses
 * one of those bounds or adds an unknown key gets an `invalid_arguments` issue naming the field
 * and limit. Text a model writes (tasks, messages, prompts) is bounded only by the
 * person-message limit, `maxMessageBytes` (256 KiB), far past any single argument a model
 * writes.
 *
 * Types, enums, constants, patterns, required fields, defaults, descriptions, array sizes and
 * other extension keys such as `x-mcp-header` are kept: they change what a model sends.
 */
type Json = Record<string, unknown>;

const schemaMaps = new Set(["properties", "$defs", "definitions", "patternProperties"]);
const schemaValues = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "not",
  "contains",
  "if",
  "then",
  "else",
]);
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const unions = ["anyOf", "oneOf"] as const;
const safeLimit = Number.MAX_SAFE_INTEGER;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function dropped(key: string, value: unknown): boolean {
  if (key === "$schema" || key === "maxLength" || key === "x-ace-constraint") return true;
  if (key === "minLength") return value === 1;
  if (key === "additionalProperties") return value === false;
  if (key === "maximum" || key === "minimum")
    return typeof value === "number" && Math.abs(value) === safeLimit;
  return false;
}

export function advertisedInputSchema(node: Json): Json {
  return compact(node);
}
/** An output schema as Codex reads it, trimmed by the same rules as an input schema. */
export function advertisedOutputSchema(node: Json): Json {
  return compact(node);
}

function compact(node: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (dropped(key, value)) continue;
    if (schemaMaps.has(key) && isRecord(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          isRecord(child) ? compact(child) : child,
        ]),
      );
    else if (schemaValues.has(key) && isRecord(value)) out[key] = compact(value);
    else if (schemaLists.has(key) && Array.isArray(value))
      out[key] = value.map((child) => (isRecord(child) ? compact(child) : child));
    else out[key] = value;
  }
  return flatten(out);
}

/** A node whose only union flattens loses the union and takes the flat schema's keys. */
function flatten(node: Json): Json {
  const present = unions.filter((key) => Array.isArray(node[key]));
  const [key] = present;
  if (present.length !== 1 || key === undefined || "type" in node) return node;
  const variants = node[key];
  const flat = Array.isArray(variants) ? flatUnion(variants) : undefined;
  if (!flat) return node;
  const { [key]: _union, ...rest } = node;
  return { ...rest, ...flat };
}
