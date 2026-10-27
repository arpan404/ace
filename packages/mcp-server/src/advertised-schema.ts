import { flatUnion } from "./schema-unions.ts";

/**
 * The schemas a model reads. Upfront-loading clients (OpenCode, Cursor, Pi, ACP) resend every
 * tool's input schema on every request, Claude and Antigravity pay for their always-loaded
 * tools' schemas on every request, and Codex reads output schemas, so keywords that only bound
 * values a model rarely approaches are dropped here. Every rule only removes keywords, so the
 * advertised schema accepts at least what the Zod schema accepts and stays valid JSON Schema for
 * every client, including the strict schema subsets Gemini and OpenAI models take. Dropped:
 *
 * - the `$schema` dialect and ace's own `x-ace-constraint` notes;
 * - string lengths and `pattern`s (ids, names, refs): the server checks them, and the
 *   `invalid_arguments` issue names the length or the pattern a call broke. A field whose pattern
 *   is its vocabulary (key names) marks itself with `keepPattern` and keeps it;
 * - numeric bounds a model would not cross by accident: a `minimum` of 0 or 1, a `maximum` of
 *   1,000 or more, and the safe-integer range;
 * - array sizes that bound nothing a model sends: `minItems: 1`, and a `maxItems` of 32 or more
 *   or one at least as large as the item enum;
 * - `additionalProperties: false` (models send the properties they are shown, and an output open
 *   to extra keys accepts ace's reserved result keys);
 * - a `description` that only restates the field's default or its enum values.
 *
 * Unions of string choices and discriminated object unions are spelled flat (`schema-unions.ts`),
 * and a union of one item or a list of them is spelled as the list.
 * `type` stays beside every `enum` and `const`: Gemini's schema subset rejects an enum without
 * one. Types, enums, constants, required fields, defaults, formats, small numeric and array
 * bounds, other descriptions and extension keys such as `x-mcp-header` are kept: they change what
 * a model sends.
 *
 * The registry still validates each call against the full Zod schema, and a call that crosses
 * one of those bounds or adds an unknown key gets an `invalid_arguments` issue naming the field
 * and the constraint, so one retry fixes it (`argument-issues.ts`).
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

/** A `maximum` at or past this bounds nothing a model would send by accident. */
const generousMaximum = 1_000;
/** A `maxItems` at or past this bounds nothing a model would send in one call. */
const generousMaxItems = 32;
const droppedKeys = new Set(["$schema", "x-ace-constraint", "maxLength", "minLength"]);
const keepPatternKey = "x-ace-keep-pattern";
/** Zod metadata for a string whose pattern is the only place its allowed values are spelled. */
export const keepPattern = { [keepPatternKey]: true } as const;

function dropped(key: string, value: unknown, node: Json): boolean {
  if (droppedKeys.has(key) || key === keepPatternKey) return true;
  if (key === "pattern") return node[keepPatternKey] !== true;
  if (key === "additionalProperties") return value === false;
  if (typeof value !== "number") return false;
  if (key === "minimum") return value === 0 || value === 1 || value === -safeLimit;
  if (key === "maximum") return value >= generousMaximum;
  if (key === "minItems") return value === 1;
  if (key === "maxItems") return value >= generousMaxItems || value >= enumSize(node["items"]);
  return false;
}
/** How many values an array's item enum allows; infinite for any other items schema. */
function enumSize(items: unknown): number {
  return isRecord(items) && Array.isArray(items["enum"])
    ? items["enum"].length
    : Number.POSITIVE_INFINITY;
}

/** Words that carry no meaning of their own beside a field's default or enum. */
const fillerWords = new Set([
  "a",
  "an",
  "and",
  "by",
  "default",
  "defaults",
  "either",
  "is",
  "of",
  "one",
  "or",
  "the",
  "to",
]);
const words = (text: string) => text.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
/** Whether a description says nothing beyond the node's default value and enum values. */
function restatesChoices(node: Json): boolean {
  const description = node["description"];
  if (typeof description !== "string") return false;
  const choices = [
    ...(Array.isArray(node["enum"]) ? node["enum"] : []),
    ...("default" in node ? [node["default"]].flat() : []),
  ].filter((choice) => ["string", "number", "boolean"].includes(typeof choice));
  if (!choices.length) return false;
  const known = new Set(choices.flatMap((choice) => words(String(choice))));
  return words(description).every((word) => fillerWords.has(word) || known.has(word));
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
    if (dropped(key, value, node)) continue;
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
  if (restatesChoices(out)) delete out["description"];
  return flatten(out);
}

/** A node whose only union flattens loses the union and takes the flat schema's keys. */
function flatten(node: Json): Json {
  const present = unions.filter((key) => Array.isArray(node[key]));
  const [key] = present;
  if (present.length !== 1 || key === undefined || "type" in node) return node;
  const variants = node[key];
  const flat = Array.isArray(variants) ? (flatUnion(variants) ?? listOfOne(variants)) : undefined;
  if (!flat) return node;
  const { [key]: _union, ...rest } = node;
  return { ...rest, ...flat };
}

/**
 * "One item, or a list of them" is advertised as the list alone: the item's schema once instead
 * of twice. A list of one says the same thing, and the Zod schema still accepts a bare item.
 */
function listOfOne(variants: readonly unknown[]): Json | undefined {
  const [first, second] = variants;
  if (variants.length !== 2 || !isRecord(first) || !isRecord(second)) return undefined;
  const [item, list] = second["type"] === "array" ? [first, second] : [second, first];
  return list["type"] === "array" && JSON.stringify(list["items"]) === JSON.stringify(item)
    ? list
    : undefined;
}
