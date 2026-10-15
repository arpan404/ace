/**
 * The input schema a model reads. Upfront-loading clients (OpenCode, Cursor, Pi, ACP) resend
 * every tool's schema on every request, so keywords that only bound values a model never
 * approaches are dropped here: the `$schema` dialect, string lengths, the safe-integer range
 * and `additionalProperties: false` (models send the properties they are shown). The registry
 * still validates each call against the full Zod schema, and a call that crosses one of those
 * bounds or adds an unknown key gets an `invalid_arguments` issue naming the field.
 *
 * Types, enums, constants, patterns, required fields, defaults, descriptions, array sizes and
 * extension keys such as `x-mcp-header` are kept: they change what a model sends.
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
const safeLimit = Number.MAX_SAFE_INTEGER;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function dropped(key: string, value: unknown): boolean {
  if (key === "$schema" || key === "maxLength") return true;
  if (key === "minLength") return value === 1;
  if (key === "additionalProperties") return value === false;
  if (key === "maximum" || key === "minimum")
    return typeof value === "number" && Math.abs(value) === safeLimit;
  return false;
}

export function advertisedInputSchema(node: Json): Json {
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
  return out;
}
