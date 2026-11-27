// SPDX-License-Identifier: Apache-2.0

/*
 * The wire fixtures' generator (ADR 0226 §3): one value per client and server message type,
 * synthesised from the schema `packages/protocol` already defines, plus the mutations the
 * property check needs. Nothing here asserts anything; Zod decides whether a sample is valid,
 * and `check:wire-fixtures` compares its answer with the Rust side's.
 *
 * Messages whose `.refine()`s constrain the whole object (a hello's one credential, a window's
 * one target) are repaired after synthesis: those rules are the ones `ace-wire/src/refine.rs`
 * states by hand, and a fixture only needs a value Zod accepts.
 */

import { z } from "zod";

/** One value to send, with where it came from. */
export interface Sample {
  source: string;
  kind: "client" | "server";
  text: string;
}

type Json = unknown;

/**
 * Every `type` a union names, with the Zod schema of that message: nested unions are flattened,
 * as `generate-transport-routes.ts` flattens them.
 */
export function messageSchemas(unions: Record<string, z.ZodType>): Map<string, z.ZodType> {
  const found = new Map<string, z.ZodType>();
  const walk = (schema: z.ZodType): void => {
    const def = (schema as unknown as { def: { type: string; options?: z.ZodType[] } }).def;
    if (def.type === "union" && def.options !== undefined) {
      for (const option of def.options) walk(option);
      return;
    }
    const type = literalOf(schema);
    if (type !== null && !found.has(type)) found.set(type, schema);
  };
  for (const schema of Object.values(unions)) walk(schema);
  return found;
}

/** The `type` literal an object schema carries, when it is a single string literal. */
function literalOf(schema: z.ZodType): string | null {
  const def = (schema as unknown as { def: Record<string, unknown> }).def;
  const shape = def.shape as Record<string, z.ZodType> | undefined;
  const field = shape?.type as unknown as
    | { def?: { type?: string; values?: Set<unknown> } }
    | undefined;
  if (field?.def?.type !== "literal") return null;
  const values = [...(field.def.values ?? [])];
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
}

/** A message's schema as the JSON Schema its input accepts, `$defs` included. */
export function inputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    reused: "ref",
  }) as Record<string, unknown>;
}

/**
 * A smallest value the schema accepts: required keys only, defaults omitted so the test covers
 * Zod filling them. Throws, naming the path, when no candidate satisfies a bound.
 */
export function synthesize(document: Record<string, unknown>, path = ""): Json {
  const defs = (document.$defs as Record<string, unknown> | undefined) ?? {};
  const node = resolve(document, defs);
  if (node === true || node === undefined) return {};
  if (node === false) throw new Error(`${path}: the schema accepts nothing`);
  const schema = node as Record<string, unknown>;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const combinator of ["oneOf", "anyOf"]) {
    const branches = schema[combinator];
    if (!Array.isArray(branches)) continue;
    const errors: string[] = [];
    for (const branch of branches) {
      try {
        return synthesize({ ...(branch as Record<string, unknown>), $defs: defs }, path);
      } catch (error) {
        errors.push(String(error));
      }
    }
    throw new Error(`${path}: no ${combinator} branch synthesises (${errors[0] ?? ""})`);
  }
  if (schema.allOf !== undefined) {
    return synthesize(
      { ...mergeAllOf([schema, ...(schema.allOf as unknown[])], defs), $defs: defs },
      path,
    );
  }
  if (Array.isArray(schema.type)) {
    const first = (schema.type as unknown[]).find((type) => type !== "null") ?? "null";
    return synthesize({ ...schema, type: first, $defs: defs }, path);
  }
  if (Array.isArray(schema.prefixItems)) {
    return (schema.prefixItems as unknown[]).map((item, index) =>
      synthesize(
        { ...(resolve(item, defs) as Record<string, unknown>), $defs: defs },
        `${path}[${index}]`,
      ),
    );
  }
  switch (schema.type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
    case "number":
      return number(schema, path);
    case "string":
      return string(schema, path);
    case "array": {
      const min = typeof schema.minItems === "number" ? schema.minItems : 0;
      const count = Math.max(min, min > 0 ? min : 1);
      return Array.from({ length: count }, (_, index) =>
        synthesize(
          { ...(schema.items as Record<string, unknown>), $defs: defs },
          `${path}[${index}]`,
        ),
      );
    }
    case "object": {
      const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
      const required = (schema.required as string[] | undefined) ?? [];
      const out: Record<string, unknown> = {};
      for (const key of required)
        out[key] = synthesize(
          { ...(properties[key] as Record<string, unknown>), $defs: defs },
          `${path}.${key}`,
        );
      return out;
    }
    default: {
      if (schema.properties !== undefined)
        return synthesize({ ...schema, type: "object", $defs: defs }, path);
      return {};
    }
  }
}

function resolve(node: unknown, defs: Record<string, unknown>): unknown {
  let current = node;
  for (let hops = 0; hops < 32; hops += 1) {
    if (current === null || typeof current !== "object") return current;
    const ref = (current as Record<string, unknown>).$ref;
    if (typeof ref !== "string") return current;
    current = defs[ref.replace(/^#\/\$defs\//, "")];
  }
  throw new Error("a $ref chain is too long");
}

/** The smallest number the schema allows. */
function number(schema: Record<string, unknown>, path: string): number {
  const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  const exclusiveMin =
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
  const exclusiveMax =
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : undefined;
  let value = schema.type === "integer" || schema.type === "number" ? 1 : 1;
  if (min !== undefined) value = Math.max(value, min);
  if (exclusiveMin !== undefined)
    value = Math.max(value, exclusiveMin + (schema.type === "integer" ? 1 : 0.5));
  if (max !== undefined && value > max) value = max;
  if (exclusiveMax !== undefined && value >= exclusiveMax) value = exclusiveMax - 1;
  if (!Number.isFinite(value)) throw new Error(`${path}: no number satisfies the bounds`);
  return value;
}

/** A string the schema allows: the shortest it permits, matching its pattern and format. */
function string(schema: Record<string, unknown>, path: string): string {
  const min = typeof schema.minLength === "number" ? schema.minLength : undefined;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined;
  const format = typeof schema.format === "string" ? schema.format : undefined;
  const formatValue: Record<string, string> = {
    url: "https://example.com/a",
    uri: "https://example.com/a",
    email: "a@b.co",
    uuid: "00000000-0000-4000-8000-000000000000",
    "date-time": "2026-01-01T00:00:00.000Z",
    ipv4: "127.0.0.1",
    ipv6: "::1",
  };
  const candidates: string[] = [];
  if (format !== undefined && formatValue[format] !== undefined)
    candidates.push(formatValue[format]);
  if (pattern !== undefined) {
    const made = fromPattern(pattern);
    if (made !== null) candidates.push(made);
  }
  const length = Math.max(min ?? 1, 1);
  candidates.push("a".repeat(length));
  for (const fill of ["0", "1", "A", "a", "-", "_"])
    candidates.push(fill.repeat(Math.max(length, 40)));
  candidates.push(`a-${"b".repeat(Math.max(length, 2))}`);
  for (const candidate of candidates) {
    if (max !== undefined && candidate.length > max) continue;
    if (min !== undefined && candidate.length < min) continue;
    if (pattern !== undefined && !new RegExp(pattern, "u").test(candidate)) continue;
    return candidate;
  }
  throw new Error(
    `${path}: no string satisfies the bounds (min ${min}, max ${max}, pattern ${pattern})`,
  );
}

/** The whole-object `.refine()`s a synthesised value has to satisfy to be a valid sample. */
export function repair(type: string, value: Json): void {
  const map = value as Record<string, unknown>;
  switch (type) {
    case "catalog.list":
      delete map.draft;
      delete map.workspace;
      map.threadId = typeof map.threadId === "string" ? map.threadId : "thread";
      break;
    case "spade.computer.drive":
      map.mode = map.mode ?? "cowork";
      break;
    case "commands.list":
      delete map.draft;
      map.threadId = typeof map.threadId === "string" ? map.threadId : "thread";
      break;
    case "hello":
      for (const key of ["ticket", "grant"]) delete map[key];
      map.token = typeof map.token === "string" ? map.token : "token";
      break;
    case "items.window":
      if (map.items !== undefined) {
        // The response: every item carries its creation sequence.
        const items = map.items as { id?: string }[];
        map.itemSeqs = Object.fromEntries(
          items.map((item, index) => [item.id ?? `i${index}`, index + 1]),
        );
        break;
      }
      for (const key of ["turnOrdinal", "itemId"]) delete map[key];
      map.aroundSeq = 1;
      map.before = 50;
      map.after = 50;
      break;
    case "turns.page":
      if (map.seq === undefined && map.before !== undefined && map.after !== undefined)
        delete map.after;
      break;
    case "thread.catchUp":
      delete map.sinceTime;
      map.sinceSeq = 1;
      break;
    case "snapshot": {
      const view = map.view as Record<string, unknown> | undefined;
      if (view === undefined) break;
      view.seq = map.seq;
      if (view.kind === "thread") {
        const order = (view.itemOrder as string[] | undefined) ?? [];
        view.itemSeqs = Object.fromEntries(order.map((id, index) => [id, index + 1]));
        view.itemsBefore = view.itemsBefore ?? null;
      }
      break;
    }
    case "events": {
      const events = (map.events as Record<string, unknown>[] | undefined) ?? [];
      events.forEach((event, index) => {
        event.seq = index + 1;
        delete event.firstSeq;
      });
      map.afterSeq = 0;
      map.throughSeq = Math.max(events.length, 1);
      break;
    }
    case "progress":
      map.afterSeq = 0;
      map.throughSeq = Math.max(Number(map.throughSeq) || 1, 1);
      break;
    case "items.page": {
      const items = (map.items as { id?: string }[] | undefined) ?? [];
      map.itemSeqs = Object.fromEntries(
        items.map((item, index) => [item.id ?? `i${index}`, index + 1]),
      );
      break;
    }
    default:
      break;
  }
}

/** Values that stress every bound a schema states, derived from one valid value. */
export function mutations(value: Json): Json[] {
  return nestedMutations(value, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Top-level mutations plus the same mutations one level inside each nested object. */
function nestedMutations(value: Json, depth: number): Json[] {
  const found = shallowMutations(value);
  if (depth >= 2) return found;
  const map = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(map)) {
    if (isPlainObject(field)) {
      for (const nested of nestedMutations(field, depth + 1)) found.push({ ...map, [key]: nested });
    } else if (Array.isArray(field) && field.length > 0 && isPlainObject(field[0])) {
      for (const nested of nestedMutations(field[0], depth + 1))
        found.push({ ...map, [key]: [nested, ...field.slice(1)] });
    }
  }
  return found;
}

function shallowMutations(value: Json): Json[] {
  const found: Json[] = [];
  const map = value as Record<string, unknown>;
  found.push({ ...map, "x-fixture-extra": true });
  for (const [key, field] of Object.entries(map)) {
    const without: Record<string, unknown> = { ...map };
    delete without[key];
    found.push(without);
    found.push({ ...map, [key]: wrongKind(field) });
    if (typeof field === "string") {
      found.push({ ...map, [key]: "" });
      found.push({ ...map, [key]: `${field}😀` });
    }
    if (typeof field === "number") {
      found.push({ ...map, [key]: field - 1 });
      found.push({ ...map, [key]: field + 1_000_000_000 });
    }
    if (Array.isArray(field)) {
      found.push({ ...map, [key]: [...field, ...field] });
      found.push({ ...map, [key]: [] });
    }
  }
  return found;
}

/** A value of another JSON kind than `field`'s, to test the type check. */
function wrongKind(field: unknown): unknown {
  if (Array.isArray(field)) return "not an array";
  if (typeof field === "string") return 1;
  if (typeof field === "number") return "not a number";
  if (typeof field === "boolean") return "not a boolean";
  if (field === null) return "not null";
  return null;
}

/** A string a simple anchored pattern accepts, or `null` when the walk can't build one. */
function fromPattern(pattern: string): string | null {
  const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
  for (const alternative of splitAlternatives(body)) {
    const built = expand(alternative);
    if (built !== null && new RegExp(pattern, "u").test(built)) return built;
  }
  return null;
}

/** Split a pattern's top-level `|` alternatives, ignoring those inside classes and groups. */
function splitAlternatives(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") index += 1;
    else if (character === "[" && !inClass) inClass = true;
    else if (character === "]" && inClass) inClass = false;
    else if (!inClass && character === "(") depth += 1;
    else if (!inClass && character === ")") depth -= 1;
    else if (!inClass && depth === 0 && character === "|") {
      parts.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(pattern.slice(start));
  return parts;
}

/** One alternative, token by token: groups expanded, classes given their first character. */
function expand(pattern: string): string | null {
  const alternatives = splitAlternatives(pattern);
  if (alternatives.length > 1) {
    for (const alternative of alternatives) {
      const built = expand(alternative);
      if (built !== null) return built;
    }
    return null;
  }
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const token = nextToken(pattern, index);
    if (token === null) return null;
    index = token.next;
    let count = 1;
    const quantifier = /^\{(\d+)(?:,(\d*))?\}|^[?*+]/.exec(pattern.slice(index));
    if (quantifier !== null) {
      index += quantifier[0].length;
      if (quantifier[0].startsWith("{")) count = Number(quantifier[1]);
      else if (quantifier[0] === "*") count = 0;
      else count = 1;
    }
    out += token.text.repeat(count);
  }
  return out;
}

/** One token's text: a class's first character, a group's expansion, or a literal. */
function nextToken(pattern: string, index: number): { text: string; next: number } | null {
  const character = pattern[index]!;
  if (character === "\\") {
    const escaped = pattern[index + 1];
    if (escaped === undefined) return null;
    const classes: Record<string, string> = { d: "1", w: "a", s: " " };
    return { text: classes[escaped] ?? escaped, next: index + 2 };
  }
  if (character === "[") {
    const end = pattern.indexOf("]", index + 2);
    if (end < 0) return null;
    const body = pattern.slice(index + 1, end);
    if (body.startsWith("^")) return { text: "a", next: end + 1 };
    if (body.startsWith("\\d")) return { text: "1", next: end + 1 };
    if (body.startsWith("\\w")) return { text: "a", next: end + 1 };
    if (body.startsWith("\\s")) return { text: " ", next: end + 1 };
    const inner = body.replace(/^\\/, "");
    const first = inner[0];
    if (first === undefined) return null;
    const char = first === "\\" ? (inner[1] ?? "a") : first;
    const mapped = char === "d" ? "1" : char === "w" ? "a" : char === "s" ? " " : char;
    return { text: mapped, next: end + 1 };
  }
  if (character === "(") {
    const end = matchingParen(pattern, index);
    if (end < 0) return null;
    const body = pattern.slice(index + 1, end);
    if (body.startsWith("?=") || body.startsWith("?!")) return { text: "", next: end + 1 };
    const inner = body.startsWith("?:") ? body.slice(2) : body;
    const expanded = expand(inner);
    return expanded === null ? null : { text: expanded, next: end + 1 };
  }
  if (character === ".") return { text: "a", next: index + 1 };
  return { text: character, next: index + 1 };
}

function matchingParen(pattern: string, open: number): number {
  let depth = 0;
  for (let index = open; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") index += 1;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The intersection of `allOf`'s parts, as one schema: constraints add, properties merge. */
function mergeAllOf(parts: unknown[], defs: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const part of parts) {
    const resolved = resolve(part, defs);
    if (resolved === null || typeof resolved !== "object") continue;
    const schema = resolved as Record<string, unknown>;
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value !== null && typeof value === "object") {
        Object.assign(properties, value as object);
      } else if (key === "required" && Array.isArray(value)) {
        required.push(...(value as string[]));
      } else if (key === "allOf") {
        Object.assign(merged, mergeAllOf(value as unknown[], defs));
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.length > 0) merged.required = [...new Set(required)];
  return merged;
}
