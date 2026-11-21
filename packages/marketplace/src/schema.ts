/*
 * The bounded schema subset a contract's input and output are written in (ADR 0200 §5.1, §7):
 * objects with known fields, strings with a length, numbers, booleans, enums and arrays with a
 * size, at most six levels deep. Read the way Spade reads it (`spade_core::schema`); the shared
 * cases in `spade/spec/conformance/contracts/schemas.json` hold both readers to it. A keyword
 * outside the subset refuses the schema, so a schema never means more than this checks.
 */

export const schemaLimits = {
  depth: 6,
  fields: 64,
  enum: 64,
  longestString: 65_536,
  items: 1_000,
  descriptionChars: 500,
  enumChars: 200,
  schemaBytes: 16 * 1024,
} as const;

/** One schema, read. */
export type Schema =
  | { kind: "object"; fields: Record<string, Schema>; required: string[] }
  | { kind: "string"; min: number; max: number; oneOf?: string[] }
  | { kind: "number"; integer: boolean; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "array"; items: Schema; min: number; max: number };

/** Where a value doesn't fit, and why. */
export interface Misfit {
  at: string;
  why: string;
}

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const common = new Set(["type", "description", "title"]);
const everyKeyword = [
  "properties",
  "required",
  "additionalProperties",
  "maxLength",
  "minLength",
  "enum",
  "minimum",
  "maximum",
  "items",
  "maxItems",
  "minItems",
];

const wholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function keywords(fields: Fields, at: string, allowed: string[], out: string[]) {
  for (const key of Object.keys(fields))
    if (!common.has(key) && !allowed.includes(key))
      out.push(`${at}: ${JSON.stringify(key)} isn't in the schema subset contracts use`);
  for (const key of ["description", "title"]) {
    const text = fields[key];
    if (
      text !== undefined &&
      (typeof text !== "string" || [...text].length > schemaLimits.descriptionChars)
    )
      out.push(`${at}.${key} is text of at most ${schemaLimits.descriptionChars} characters`);
  }
}

function count(fields: Fields, key: string, at: string, out: string[]): number | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (wholeNumber(value)) return value;
  out.push(`${at}.${key} is a whole number`);
  return undefined;
}

function node(value: unknown, at: string, depth: number, out: string[]): Schema | undefined {
  if (depth > schemaLimits.depth) {
    out.push(`${at}: a schema nests at most ${schemaLimits.depth} levels`);
    return undefined;
  }
  if (!isFields(value)) {
    out.push(`${at} is a schema object`);
    return undefined;
  }
  const type = value["type"];
  const kind =
    typeof type === "string" ? type : type === undefined && "enum" in value ? "string" : undefined;
  if (kind === undefined) {
    keywords(value, at, everyKeyword, out);
    out.push(`${at}.type is object, string, number, integer, boolean or array`);
    return undefined;
  }
  switch (kind) {
    case "object":
      return object(value, at, depth, out);
    case "string":
      return string(value, at, out);
    case "number":
    case "integer": {
      keywords(value, at, ["minimum", "maximum"], out);
      const bound = (key: string) => {
        const n = value[key];
        if (n === undefined) return undefined;
        if (typeof n === "number") return n;
        out.push(`${at}.${key} is a number`);
        return undefined;
      };
      const [min, max] = [bound("minimum"), bound("maximum")];
      if (min !== undefined && max !== undefined && min > max)
        out.push(`${at}: minimum is more than maximum`);
      return {
        kind: "number",
        integer: kind === "integer",
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
    }
    case "boolean":
      keywords(value, at, [], out);
      return { kind: "boolean" };
    case "array": {
      keywords(value, at, ["items", "maxItems", "minItems"], out);
      let max = count(value, "maxItems", at, out);
      const min = count(value, "minItems", at, out) ?? 0;
      if (max === undefined || max < 1 || max > schemaLimits.items) {
        out.push(`${at}.maxItems says how long the list may be, 1 to ${schemaLimits.items}`);
        max = 1;
      }
      if (min > max) out.push(`${at}: minItems is more than maxItems`);
      if (value["items"] === undefined) {
        out.push(`${at}.items says what the list holds`);
        return undefined;
      }
      const items = node(value["items"], `${at}.items`, depth + 1, out);
      return items && { kind: "array", items, min, max };
    }
    default:
      out.push(
        `${at}.type ${JSON.stringify(kind)} isn't object, string, number, integer, boolean or array`,
      );
      return undefined;
  }
}

function object(value: Fields, at: string, depth: number, out: string[]): Schema | undefined {
  keywords(value, at, ["properties", "required", "additionalProperties"], out);
  const extra = value["additionalProperties"];
  if (extra !== undefined && extra !== false)
    out.push(`${at}.additionalProperties is false: an object has only the fields it names`);
  const properties = value["properties"] ?? {};
  if (!isFields(properties) || Object.keys(properties).length > schemaLimits.fields) {
    out.push(`${at}.properties names at most ${schemaLimits.fields} fields`);
    return undefined;
  }
  const fields: Record<string, Schema> = {};
  for (const [name, item] of Object.entries(properties)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
      out.push(
        `${at}.properties: ${JSON.stringify(name)} is a field name of 1 to 64 letters, digits and _`,
      );
      continue;
    }
    const read = node(item, `${at}.${name}`, depth + 1, out);
    if (read) fields[name] = read;
  }
  const required: string[] = [];
  const names = value["required"];
  if (names !== undefined && !Array.isArray(names))
    out.push(`${at}.required is a list of field names`);
  else
    for (const name of names ?? [])
      if (typeof name === "string" && name in properties) required.push(name);
      else out.push(`${at}.required names fields its properties have`);
  return { kind: "object", fields, required };
}

function string(value: Fields, at: string, out: string[]): Schema {
  keywords(value, at, ["maxLength", "minLength", "enum"], out);
  let oneOf: string[] | undefined;
  const words = value["enum"];
  if (words !== undefined) {
    if (!Array.isArray(words) || words.length < 1 || words.length > schemaLimits.enum)
      out.push(`${at}.enum lists 1 to ${schemaLimits.enum} words`);
    else if (!words.every((w) => typeof w === "string" && [...w].length <= schemaLimits.enumChars))
      out.push(`${at}.enum lists words of at most ${schemaLimits.enumChars} characters`);
    else oneOf = words as string[];
  }
  const longest = oneOf && Math.max(...oneOf.map((w) => [...w].length));
  const given = count(value, "maxLength", at, out);
  let max: number;
  if (given !== undefined && given >= 1 && given <= schemaLimits.longestString) max = given;
  else if (given === undefined && longest !== undefined) max = Math.max(longest, 1);
  else {
    out.push(`${at}.maxLength says how long the text may be, 1 to ${schemaLimits.longestString}`);
    max = 1;
  }
  const min = count(value, "minLength", at, out) ?? 0;
  if (min > max) out.push(`${at}: minLength is more than maxLength`);
  return { kind: "string", min, max, ...(oneOf ? { oneOf } : {}) };
}

/** Reads `value` as a schema of the subset; `problems` names each place that refuses it. */
export function readSchema(
  value: unknown,
  at: string,
): { schema: Schema | undefined; problems: string[] } {
  if (JSON.stringify(value ?? null).length > schemaLimits.schemaBytes)
    return {
      schema: undefined,
      problems: [`${at} is longer than ${schemaLimits.schemaBytes / 1024} KiB`],
    };
  const problems: string[] = [];
  const schema = node(value, at, 1, problems);
  return { schema: problems.length ? undefined : schema, problems };
}

function kindWords(schema: Schema): string {
  switch (schema.kind) {
    case "object":
      return "an object";
    case "string":
      return schema.oneOf ? "one of its words" : "text";
    case "number":
      return schema.integer ? "a whole number" : "a number";
    case "boolean":
      return "true or false";
    case "array":
      return "a list";
  }
}

function walk(schema: Schema, value: unknown, at: string, out: Misfit[]) {
  if (out.length >= 20) return;
  const miss = (why: string) => out.push({ at, why });
  if (schema.kind === "object" && isFields(value)) {
    for (const name of schema.required)
      if (!(name in value)) out.push({ at: `${at}.${name}`, why: "is missing" });
    for (const [name, item] of Object.entries(value)) {
      const field = schema.fields[name];
      if (field) walk(field, item, `${at}.${name}`, out);
      else out.push({ at: `${at}.${name}`, why: "isn't a field this takes" });
    }
  } else if (schema.kind === "string" && typeof value === "string") {
    const length = [...value].length;
    if (schema.oneOf) {
      if (!schema.oneOf.includes(value)) miss(`is one of ${schema.oneOf.join(", ")}`);
    } else if (length > schema.max) miss(`is at most ${schema.max} characters`);
    else if (length < schema.min) miss(`is at least ${schema.min} characters`);
  } else if (schema.kind === "number" && typeof value === "number") {
    if (schema.integer && !Number.isInteger(value)) miss("is a whole number");
    else if (schema.min !== undefined && value < schema.min) miss(`is at least ${schema.min}`);
    else if (schema.max !== undefined && value > schema.max) miss(`is at most ${schema.max}`);
  } else if (schema.kind === "boolean" && typeof value === "boolean") {
    // fits
  } else if (schema.kind === "array" && Array.isArray(value)) {
    if (value.length > schema.max) miss(`holds at most ${schema.max} items`);
    else if (value.length < schema.min) miss(`holds at least ${schema.min} items`);
    value.slice(0, schema.max).forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, out));
  } else miss(`is ${kindWords(schema)}`);
}

/** Every place `value` doesn't fit `schema`, under `at`; empty when it fits. */
export function schemaMisfits(schema: Schema, value: unknown, at: string): Misfit[] {
  const out: Misfit[] = [];
  walk(schema, value, at, out);
  return out;
}
