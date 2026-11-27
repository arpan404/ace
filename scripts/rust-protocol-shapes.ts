// SPDX-License-Identifier: Apache-2.0

/*
 * Writes the `ace-protocol/src/shapes/` table (porting guide 5.3b): what each Zod schema
 * keeps, with its defaults, bounds and key order, split by root. The walk throws, naming the
 * path, on any construct whose output the table can't describe.
 */

import { z } from "zod";
import {
  catchFallback,
  checksOf,
  customSource,
  lengthBounds,
  numBounds,
  strBounds,
  type NumBounds,
  type StrBounds,
} from "./rust-protocol-bounds.ts";
import { resolveCheck } from "./rust-protocol-checks.ts";

type Extra = "strip" | "reject" | "keep" | "shaped";

/** One shape the walk emits. */
type Node =
  | { kind: "any" }
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "str"; bounds: StrBounds }
  | { kind: "num"; bounds: NumBounds }
  | { kind: "enum"; values: string[] }
  | { kind: "object"; plan: Plan; extra: Extra; rest?: Node }
  | { kind: "array"; item: Node; min?: number; max?: number }
  | { kind: "tuple"; items: Node[] }
  | { kind: "record"; key: Node; inner: Node; keepProto: boolean }
  | { kind: "nullable"; inner: Node }
  | { kind: "tagged"; key: string; options: { literal: string; shape: Node }[] }
  | { kind: "oneOf"; options: Node[] }
  | { kind: "all"; shapes: Node[] }
  | { kind: "later"; name: string; root: string }
  | { kind: "custom"; path: string }
  | { kind: "option"; inner: Node }
  | { kind: "catch"; inner: Node; fallback: string }
  | { kind: "fallback"; rest: Node; input: Node; fallback: string }
  | { kind: "checked"; inner: Node; check: string };

interface Plan {
  readonly fields: { key: string; presence: Presence; shape: Node }[];
  readonly name: string;
  readonly root: string;
  file: string;
}

type Presence = { kind: "required" } | { kind: "optional" } | { kind: "default"; text: string };

/** Zod 4's runtime definitions, as much of them as the walk reads. */
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  items?: z.ZodType[];
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  innerType?: z.ZodType;
  defaultValue?: unknown;
  format?: unknown;
  entries?: Record<string, unknown>;
  values?: Set<unknown>;
  getter?: () => z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

function fail(path: string, reason: string): never {
  throw new Error(`rust-protocol-shapes: ${path}: ${reason}`);
}

/** A default, as the JSON text Zod inserts: the literal as written, key order included. */
function defaultText(path: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? fail(path, "a default is undefined");
  } catch {
    return fail(path, "a default is not JSON");
  }
}

/** The schema a transform's `x-ace-json-input` names, when its output can't be written out. */
function metaInput(schema: z.ZodType): z.ZodType | undefined {
  const meta = (schema as unknown as { meta?: () => Record<string, unknown> }).meta?.();
  const input = meta?.["x-ace-json-input"];
  if (input === null || typeof input !== "object") return undefined;
  return (input as { def?: unknown }).def === undefined ? undefined : (input as z.ZodType);
}

/** A transform or pipe that outputs a constant, with the input schema and that constant. */
function transformedConstant(schema: z.ZodType): { input: z.ZodType; output: unknown } | null {
  const def = defOf(schema) as unknown as { type: string; innerType?: z.ZodType; in?: z.ZodType };
  const input = def.type === "transform" ? def.innerType : def.type === "pipe" ? def.in : undefined;
  if (input === undefined) return null;
  const probe = (
    schema as unknown as { safeParse: (value: unknown) => { success: boolean; data?: unknown } }
  ).safeParse(null);
  if (probe.success) return { input, output: probe.data };
  for (const candidate of [0, "a", "", true, {}, []]) {
    const result = (
      schema as unknown as { safeParse: (value: unknown) => { success: boolean; data?: unknown } }
    ).safeParse(candidate);
    if (result.success) return { input, output: result.data };
  }
  return null;
}

/**
 * A transform over `z.unknown()`: any value is accepted and the output is a constant. Zod uses
 * this to read an unknown field as `undefined` (dropped) or as one listed fallback.
 */

/** Plans the shape of one schema. Objects are deduplicated by identity. */
class Planner {
  readonly objects = new Map<z.ZodType, Plan>();
  readonly order: Plan[] = [];
  readonly used = new Set<string>();
  readonly lazies = new Map<z.ZodType, { name: string; node: Node | undefined; root: string }>();
  readonly customs: ReadonlyMap<z.ZodType, string>;
  root = "";

  constructor(customs: ReadonlyMap<z.ZodType, string> = new Map()) {
    this.customs = customs;
  }

  object(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.objects.get(schema);
    if (existing !== undefined)
      return {
        kind: "object",
        plan: existing,
        extra: defOf(schema).catchall === undefined ? "strip" : extraOf(schema, path),
      };
    const def = defOf(schema);
    const extra = def.catchall === undefined ? "strip" : extraOf(schema, path);
    const shape = def.shape;
    if (shape === undefined) fail(path, "an object has no shape");
    let unique = name;
    for (let suffix = 2; this.used.has(unique); suffix += 1) unique = `${name}_${suffix}`;
    this.used.add(unique);
    const plan: Plan = { name: unique, fields: [], root: this.root, file: "" };
    this.objects.set(schema, plan);
    this.order.push(plan);
    for (const [key, field] of Object.entries(shape)) {
      plan.fields.push(this.field(key, field, `${path}.${key}`));
    }
    return { kind: "object", plan, extra };
  }

  lazy(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.lazies.get(schema);
    if (existing !== undefined) return { kind: "later", name: existing.name, root: existing.root };
    const getter = defOf(schema).getter;
    if (getter === undefined) return fail(path, "a lazy schema has no getter");
    let unique = name;
    for (let suffix = 2; this.used.has(unique); suffix += 1) unique = `${name}_${suffix}`;
    this.used.add(unique);
    const entry = { name: unique, node: undefined as Node | undefined, root: this.root };
    this.lazies.set(schema, entry);
    entry.node = this.shape(getter(), path);
    return { kind: "later", name: unique, root: this.root };
  }

  /** One object field, applying `.optional()` or `.default()` as its presence. */
  private field(key: string, schema: z.ZodType, path: string): Plan["fields"][number] {
    let presence: Presence = { kind: "required" };
    let inner = schema;
    for (let wrapper = defOf(inner); ; wrapper = defOf(inner)) {
      if (wrapper.type === "optional") {
        if (presence.kind === "required") presence = { kind: "optional" };
        inner = requireInner(wrapper, path);
        continue;
      }
      if (wrapper.type === "default") {
        if (presence.kind === "required")
          presence = { kind: "default", text: defaultText(path, wrapper.defaultValue) };
        inner = requireInner(wrapper, path);
        continue;
      }
      break;
    }
    return { key, presence, shape: this.shape(inner, path) };
  }

  private shape(schema: z.ZodType, path: string): Node {
    const custom = this.customs.get(schema);
    if (custom !== undefined) return { kind: "custom", path: custom };
    const def = defOf(schema);
    const checks = checksOf(def as unknown as Record<string, unknown>)
      .filter((check) => check.check === "custom")
      .map((check) => {
        const source = customSource(check);
        if (source === undefined) fail(path, "a refinement has no function");
        return resolveCheck(source, path);
      });
    const node = this.shapeInner(schema, path, def);
    // A string's refinements run at their place among its ordered checks, so they are already
    // part of `StrBounds`; every other node wraps its own rule around the parsed value.
    let wrapped = node;
    if (node.kind !== "str")
      for (const check of checks)
        if (check.message !== true)
          wrapped = { kind: "checked", inner: wrapped, check: check.name };
    return wrapped;
  }

  private shapeInner(schema: z.ZodType, path: string, def: Def): Node {
    switch (def.type) {
      case "string":
        return {
          kind: "str",
          bounds: strBounds(
            def as unknown as Record<string, unknown>,
            path,
            (source, at) => resolveCheck(source, at).name,
          ),
        };
      case "number":
      case "int":
        return { kind: "num", bounds: numBounds(def as unknown as Record<string, unknown>, path) };
      case "boolean":
        return { kind: "bool" };
      case "null":
        return { kind: "null" };
      case "unknown":
      case "any":
        return { kind: "any" };
      case "literal": {
        const values = def.values;
        if (values === undefined) return fail(path, "a literal has no values");
        return { kind: "enum", values: [...values].map((value) => enumText(value, path)) };
      }
      case "enum": {
        const entries = def.entries;
        if (entries === undefined) return fail(path, "an enum has no entries");
        return {
          kind: "enum",
          values: Object.values(entries).map((value) => enumText(value, path)),
        };
      }
      case "readonly": {
        const inner = def.innerType;
        if (inner === undefined) return fail(path, "readonly has no inner type");
        return this.shape(inner, path);
      }
      case "object":
        return this.object(schema, snake(path), path);
      case "array": {
        const element = def.element;
        if (element === undefined) return fail(path, "an array has no element");
        return {
          kind: "array",
          item: this.shape(element, `${path}[]`),
          ...lengthBounds(def as unknown as Record<string, unknown>, path),
        };
      }
      case "tuple": {
        const items = def.items;
        if (items === undefined) return fail(path, "a tuple has no items");
        return { kind: "tuple", items: items.map((item, i) => this.shape(item, `${path}[${i}]`)) };
      }
      case "record": {
        const keyType = def.keyType;
        const valueType = def.valueType;
        if (keyType === undefined || valueType === undefined)
          return fail(path, "a record has no key or value type");
        const keyDef = defOf(keyType);
        if (keyDef.type === "enum") {
          // An enum-keyed record is an object with exactly those keys: all required for
          // `z.record`, each optional for `z.partialRecord`, any other key rejected.
          const partial = (def as unknown as { partial?: unknown }).partial === true;
          const entries = Object.values(keyDef.entries ?? {});
          if (entries.length === 0) return fail(path, "an enum-keyed record has no keys");
          let unique = snake(path);
          for (let suffix = 2; this.used.has(unique); suffix += 1)
            unique = `${snake(path)}_${suffix}`;
          this.used.add(unique);
          const plan: Plan = { name: unique, fields: [], root: this.root, file: "" };
          this.order.push(plan);
          for (const value of entries) {
            const key = String(value);
            plan.fields.push({
              key,
              presence: partial ? { kind: "optional" } : { kind: "required" },
              shape: this.shape(valueType, `${path}{${key}}`),
            });
          }
          return { kind: "object", plan, extra: "reject" };
        }
        if (keyDef.type !== "string" && keyDef.type !== "template_literal")
          return fail(path, "a record's key is not a string");
        return {
          kind: "record",
          key: this.shape(keyType, `${path}{key}`),
          inner: this.shape(valueType, `${path}{value}`),
          keepProto: false,
        };
      }
      case "nullable": {
        const inner = requireInner(def, path);
        return { kind: "nullable", inner: this.shape(inner, path) };
      }
      case "union": {
        const options = def.options;
        if (options === undefined) return fail(path, "a union has no options");
        const constant = options
          .map((option) => ({ option, transformed: transformedConstant(option) }))
          .find((entry) => entry.transformed !== null);
        if (constant?.transformed !== undefined && constant.transformed !== null) {
          const rest = options.filter((option) => option !== constant.option);
          const inner: Node =
            rest.length === 1
              ? this.shape(rest[0]!, path)
              : {
                  kind: "oneOf",
                  options: rest.map((option, index) => this.shape(option, `${path}|${index}`)),
                };
          const output = constant.transformed.output;
          if (output === undefined) return { kind: "option", inner };
          const text = JSON.stringify(output);
          if (text === undefined) return fail(path, "a transform's output is not JSON");
          const inputShape = this.shape(constant.transformed.input, `${path}|fallback`);
          // A transform over `z.unknown()` accepts anything, which is `.catch()`'s promise;
          // one over a string accepts only its input.
          return inputShape.kind === "any"
            ? { kind: "catch", inner, fallback: text }
            : { kind: "fallback", rest: inner, input: inputShape, fallback: text };
        }
        if (def.discriminator !== undefined) return this.tagged(def.discriminator, options, path);
        return {
          kind: "oneOf",
          options: options.map((option, index) => this.shape(option, `${path}|${index}`)),
        };
      }
      case "intersection": {
        const left = def.left;
        const right = def.right;
        if (left === undefined || right === undefined)
          return fail(path, "an intersection has no sides");
        return this.merge(this.shape(left, `${path}&0`), this.shape(right, `${path}&1`), path);
      }
      case "catch": {
        const inner = requireInner(def, path);
        return {
          kind: "catch",
          inner: this.shape(inner, path),
          fallback: catchFallback(schema, path),
        };
      }
      case "pipe":
      case "transform":
      case "custom": {
        const meta = (schema as unknown as { meta?: () => Record<string, unknown> }).meta?.();
        if (meta?.["x-ace-record"] === "opaque") {
          const named = metaInput(schema);
          if (named === undefined) return fail(path, "an opaque record names no input schema");
          const record = defOf(named);
          if (
            record.type !== "record" ||
            record.keyType === undefined ||
            record.valueType === undefined
          )
            return fail(path, "an opaque record is not a record");
          return {
            kind: "record",
            key: this.shape(record.keyType, `${path}{key}`),
            inner: this.shape(record.valueType, `${path}{value}`),
            keepProto: true,
          };
        }
        const named = metaInput(schema);
        if (named !== undefined) return this.shape(named, path);
        return fail(path, `a ${def.type} names no input schema (x-ace-json-input)`);
      }
      case "lazy":
        return this.lazy(schema, snake(path), path);
      case "optional":
      case "default":
        return fail(path, `.${def.type}() is not directly on an object field`);
      default:
        return fail(path, `the table can't describe \`${def.type}\``);
    }
  }

  private tagged(key: string, options: z.ZodType[], path: string): Node {
    const planned: { literal: string; shape: Node }[] = [];
    const add = (option: { literal: string; shape: Node }): void => {
      const existing = planned.find((plannedOption) => plannedOption.literal === option.literal);
      if (existing === undefined) {
        planned.push(option);
        return;
      }
      existing.shape =
        existing.shape.kind === "oneOf"
          ? { kind: "oneOf", options: [...existing.shape.options, option.shape] }
          : { kind: "oneOf", options: [existing.shape, option.shape] };
    };
    for (const [index, option] of options.entries()) {
      const optionPath = `${path}|${index}`;
      const def = defOf(option);
      if (def.type === "union") {
        for (const nested of this.tagged(key, def.options ?? [], optionPath).options) add(nested);
        continue;
      }
      if (def.type !== "object") return fail(optionPath, `a discriminated option is a ${def.type}`);
      const field = def.shape?.[key];
      if (field === undefined) return fail(optionPath, `an option has no \`${key}\``);
      const fieldDef = defOf(field);
      const values =
        fieldDef.type === "enum"
          ? Object.values(fieldDef.entries ?? {})
          : fieldDef.type === "literal"
            ? [...(fieldDef.values ?? [])]
            : fail(optionPath, `the discriminator \`${key}\` is not a literal or enum`);
      if (values.length === 0)
        return fail(optionPath, `the discriminator \`${key}\` has no literal value`);
      const shape = this.shape(option, optionPath);
      for (const value of values) add({ literal: enumText(value, optionPath), shape });
    }
    return { kind: "tagged", key, options: planned };
  }

  merge(a: Node, b: Node, path: string): Node {
    const checks: string[] = [];
    let left = a;
    while (left.kind === "checked") {
      checks.push(left.check);
      left = left.inner;
    }
    let right = b;
    while (right.kind === "checked") {
      checks.push(right.check);
      right = right.inner;
    }
    const merged = this.mergeInner(left, right, path);
    return checks.reduce<Node>((node, check) => ({ kind: "checked", inner: node, check }), merged);
  }

  private mergeInner(a: Node, b: Node, path: string): Node {
    if (a.kind === "any") return b;
    if (b.kind === "any") return a;
    if (a.kind === b.kind && a.kind !== "tagged" && a.kind !== "object")
      return { kind: "all", shapes: [a, b] };
    if (a.kind === "record" && b.kind === "object") return { ...b, extra: "shaped", rest: a.inner };
    if (a.kind === "object" && b.kind === "record") return { ...a, extra: "shaped", rest: b.inner };
    if (a.kind === "object" && b.kind === "object") return this.mergeObjects(a, b);
    if (a.kind === "tagged" && b.kind === "object")
      return {
        kind: "tagged",
        key: a.key,
        options: a.options.map((option) => ({
          literal: option.literal,
          shape: this.merge(option.shape, b, path),
        })),
      };
    if (a.kind === "object" && b.kind === "tagged")
      return {
        kind: "tagged",
        key: b.key,
        options: b.options.map((option) => ({
          literal: option.literal,
          shape: this.merge(a, option.shape, path),
        })),
      };
    return fail(path, `an intersection joins ${a.kind} and ${b.kind}`);
  }

  private mergeObjects(
    a: { kind: "object"; plan: Plan; extra: Extra },
    b: { kind: "object"; plan: Plan; extra: Extra },
  ): Node {
    const fields = [...a.plan.fields];
    for (const field of b.plan.fields) {
      if (!fields.some((candidate) => candidate.key === field.key)) fields.push(field);
    }
    let name = a.plan.name;
    for (let suffix = 2; this.used.has(name); suffix += 1) name = `${a.plan.name}_${suffix}`;
    this.used.add(name);
    const plan: Plan = { name, fields, root: this.root, file: "" };
    this.order.push(plan);
    return {
      kind: "object",
      plan,
      extra:
        a.extra === "keep" || b.extra === "keep"
          ? "keep"
          : a.extra === "reject"
            ? "reject"
            : b.extra,
    };
  }

  depth(node: Node): number {
    switch (node.kind) {
      case "any":
      case "null":
      case "bool":
      case "str":
      case "num":
      case "enum":
      case "all":
      case "later":
      case "custom":
        return 0;
      case "object":
        return 1 + Math.max(0, ...node.plan.fields.map((field) => this.depth(field.shape)));
      case "array":
        return 1 + this.depth(node.item);
      case "record":
        return 1 + Math.max(this.depth(node.key), this.depth(node.inner));
      case "nullable":
      case "option":
      case "catch":
      case "checked":
        return 1 + this.depth(node.inner);
      case "fallback":
        return 1 + Math.max(this.depth(node.rest), this.depth(node.input));
      case "tuple":
        return 1 + Math.max(0, ...node.items.map((item) => this.depth(item)));
      case "tagged":
        return 1 + Math.max(0, ...node.options.map((option) => this.depth(option.shape)));
      case "oneOf":
        return 1 + Math.max(0, ...node.options.map((option) => this.depth(option)));
    }
  }
}

function requireInner(def: Def, path: string): z.ZodType {
  const inner = def.innerType;
  if (inner === undefined) return fail(path, `${def.type} has no inner type`);
  return inner;
}

/** A literal or enum value as JSON text (`"\"pr\""`, `"true"`). */
function enumText(value: unknown, path: string): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return fail(path, "an enum value is undefined");
    return text;
  } catch {
    return fail(path, "an enum value is not JSON");
  }
}

function extraOf(schema: z.ZodType, path: string): Extra {
  const catchall = defOf(schema).catchall;
  if (catchall === undefined) return "strip";
  const type = defOf(catchall).type;
  if (type === "never") return "reject";
  if (type === "unknown" || type === "any") return "keep";
  return fail(path, `an object has a ${type} catchall`);
}

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function rustString(text: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u{${code.toString(16)}}`;
    else out += character;
  }
  return `${out}"`;
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "None" : `Some(${value})`;
}

/** A number as Rust's `f64` literal: no integer literal ever coerces into an `Option<f64>`. */
function float(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

function optionalFloat(value: number | undefined): string {
  return value === undefined ? "None" : `Some(${float(value)})`;
}

function strExpr(bounds: StrBounds): string {
  const checks = bounds.checks.map((check) => {
    switch (check.kind) {
      case "min":
        return `StrCheck::Min(${check.value})`;
      case "max":
        return `StrCheck::Max(${check.value})`;
      case "pattern":
        return `StrCheck::Pattern(${rustString(check.value)})`;
      case "format":
        return `StrCheck::Format(${rustString(check.value)})`;
      case "trim":
        return "StrCheck::Trim";
      case "custom":
        return `StrCheck::Custom(&crate::checks::${check.name})`;
    }
  });
  return `Shape::Str(&StrBounds { checks: &[${checks.join(", ")}] })`;
}

function numExpr(bounds: NumBounds): string {
  return `Shape::Num(&NumBounds { min: ${optionalFloat(bounds.min)}, min_inclusive: ${bounds.minInclusive === true}, max: ${optionalFloat(bounds.max)}, max_inclusive: ${bounds.maxInclusive === true}, integral: ${bounds.integral === true} })`;
}

function shapeExpr(node: Node, file: string): string {
  switch (node.kind) {
    case "any":
      return "Shape::Any";
    case "null":
      return "Shape::Null";
    case "bool":
      return "Shape::Bool";
    case "str":
      return strExpr(node.bounds);
    case "num":
      return numExpr(node.bounds);
    case "enum":
      return `Shape::Enum(&[${node.values.map((value) => rustString(value)).join(", ")}])`;
    case "object": {
      const name = `${node.plan.name}_FIELDS`;
      const fields =
        node.plan.file === file ? `${name}` : `crate::shapes::${node.plan.file}::${name}`;
      const extra =
        node.extra === "shaped" && node.rest !== undefined
          ? `Extra::Shaped(&${shapeExpr(node.rest, file)})`
          : `Extra::${node.extra === "strip" ? "Strip" : node.extra === "reject" ? "Reject" : "Keep"}`;
      return `Shape::Object { fields: &${fields}, extra: ${extra} }`;
    }
    case "array":
      return `Shape::Array { item: &${shapeExpr(node.item, file)}, min: ${optionalNumber(node.min)}, max: ${optionalNumber(node.max)} }`;
    case "tuple":
      return `Shape::Tuple(&[${node.items.map((item) => shapeExpr(item, file)).join(", ")}])`;
    case "record":
      return `Shape::Record { key: &${shapeExpr(node.key, file)}, value: &${shapeExpr(node.inner, file)}, keep_proto: ${node.keepProto} }`;
    case "nullable":
      return `Shape::Nullable(&${shapeExpr(node.inner, file)})`;
    case "option":
      return `Shape::Option(&${shapeExpr(node.inner, file)})`;
    case "catch":
      return `Shape::Catch { inner: &${shapeExpr(node.inner, file)}, fallback: ${rustString(node.fallback)} }`;
    case "fallback":
      return `Shape::Fallback { rest: &${shapeExpr(node.rest, file)}, input: &${shapeExpr(node.input, file)}, fallback: ${rustString(node.fallback)} }`;
    case "tagged": {
      const options = node.options
        .map((option) => `(${rustString(option.literal)}, ${shapeExpr(option.shape, file)})`)
        .join(", ");
      return `Shape::Tagged { key: ${rustString(node.key)}, options: &[${options}] }`;
    }
    case "oneOf":
      return `Shape::OneOf(&[${node.options.map((option) => shapeExpr(option, file)).join(", ")}])`;
    case "all":
      return `Shape::All(&[${node.shapes.map((shape) => shapeExpr(shape, file)).join(", ")}])`;
    case "later": {
      const lazyFile = `${snake(node.root).toLowerCase()}_lazy`;
      return lazyFile === file
        ? `Shape::Later(&${node.name})`
        : `Shape::Later(&crate::shapes::${lazyFile}::${node.name})`;
    }
    case "custom":
      return `Shape::Custom(&${node.path})`;
    case "checked":
      return `Shape::Checked { inner: &${shapeExpr(node.inner, file)}, check: &crate::checks::${node.check} }`;
  }
}

function presenceExpr(presence: Presence): string {
  switch (presence.kind) {
    case "required":
      return "Presence::Required";
    case "optional":
      return "Presence::Optional";
    case "default":
      return `Presence::Default(${rustString(presence.text)})`;
  }
}

/** Splits each root's plans into files small enough for rustfmt to keep under 400 lines. */
function chunks(
  roots: string[],
  plans: Plan[],
): { file: string; plans: Plan[]; roots: string[] }[] {
  const found: { file: string; plans: Plan[]; roots: string[] }[] = [];
  for (const root of roots) {
    const group = plans.filter((plan) => plan.root === root);
    const base = snake(root).toLowerCase();
    let plansInFile: Plan[] = [];
    let estimated = 0;
    let index = 1;
    const flush = () => {
      const file = index === 1 ? base : `${base}_${index}`;
      for (const plan of plansInFile) plan.file = file;
      found.push({ file, plans: plansInFile, roots: [] });
      plansInFile = [];
      estimated = 0;
      index += 1;
    };
    for (const plan of group) {
      const cost = plan.fields.length * 6 + 12;
      if (plansInFile.length > 0 && estimated + cost > 320) flush();
      plansInFile.push(plan);
      estimated += cost;
    }
    if (plansInFile.length > 0) flush();
  }
  return found;
}

/** The table's files, keyed by name under `ace-protocol/src/shapes/`; throws naming the path. */
export function shapesSource(
  roots: Record<string, z.ZodType>,
  customs: ReadonlyMap<z.ZodType, string> = new Map(),
): Map<string, string> {
  const planner = new Planner(customs);
  const rootNodes: [string, Node][] = [];
  const names = Object.keys(roots);
  for (const name of names) {
    planner.root = name;
    const node = planner.shape(roots[name]!, name);
    if (node === undefined) throw new Error(`root ${name} planned nothing`);
    rootNodes.push([name, node]);
  }
  const depth = Math.max(0, ...rootNodes.map(([, node]) => planner.depth(node)));
  const files = chunks(names, planner.order);
  const lazyFiles = new Map<string, string[]>();
  for (const entry of planner.lazies.values()) {
    if (entry.node === undefined) continue;
    const file = `${snake(entry.root).toLowerCase()}_lazy`;
    files.push({ file, plans: [], roots: [] });
    lazyFiles.set(file, [...(lazyFiles.get(file) ?? []), entry.name]);
  }
  for (const entry of rootNodes) {
    const [root, node] = entry;
    if (node.kind === "object") {
      const chunk = files.find((candidate) => candidate.file === node.plan.file);
      if (chunk !== undefined) chunk.roots.push(entry);
      continue;
    }
    files.push({ file: `${snake(root).toLowerCase()}_root`, plans: [], roots: [entry] });
  }
  const head = [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Generated by scripts/generate-rust-protocol.ts -- do not edit.",
    "// The shape table for the wire and the thread column encoders (porting guide 5.3b).",
    "#![allow(dead_code)]",
    "#![allow(unused_imports)]",
    "",
  ];
  const module = [
    ...head,
    "// Split by root so no file outgrows the source limit.",
    "// What Zod's parse keeps, in schema order, with the defaults it inserts.",
    `// Depth ${depth}: the deepest Shape nesting, which bounds the walk; the walk follows`,
    "// this table, never the value.",
    "",
  ];
  for (const chunk of files)
    module.push(
      `mod ${chunk.file};`,
      ...chunk.roots.map(([root]) => `pub use ${chunk.file}::${root};`),
      ...(lazyFiles.get(chunk.file) ?? []).map((lazy) => `pub use ${chunk.file}::${lazy};`),
    );
  const result = new Map([["mod.rs", `${module.join("\n").trimEnd()}\n`]]);
  for (const chunk of files) {
    const lines = [
      ...head,
      `// Part ${chunk.file}.`,
      "use crate::shape::{Extra, Field, NumBounds, Presence, Shape, StrBounds, StrCheck};",
      "",
    ];
    for (const plan of chunk.plans) {
      lines.push(`pub(crate) static ${plan.name}_FIELDS: [Field; ${plan.fields.length}] = [`);
      for (const field of plan.fields) {
        lines.push(
          `    Field { key: ${rustString(field.key)}, presence: ${presenceExpr(
            field.presence,
          )}, shape: ${shapeExpr(field.shape, chunk.file)} },`,
        );
      }
      lines.push("];", "");
    }
    for (const [root, node] of chunk.roots)
      lines.push(`pub static ${root}: Shape = ${shapeExpr(node, chunk.file)};`, "");
    for (const entry of planner.lazies.values())
      if (entry.node !== undefined && chunk.file === `${snake(entry.root).toLowerCase()}_lazy`) {
        lines.push(`pub static ${entry.name}: Shape = ${shapeExpr(entry.node, chunk.file)};`, "");
      }
    result.set(`${chunk.file}.rs`, `${lines.join("\n").trimEnd()}\n`);
  }
  return result;
}
