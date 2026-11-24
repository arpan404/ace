// SPDX-License-Identifier: Apache-2.0

/*
 * Writes `native/daemon/crates/ace-protocol/src/shapes.rs`, the shape table the column
 * encoders use (ADR 0222, porting guide 5.3b): what each Zod object keeps, in schema order,
 * with the defaults it inserts. `generate-rust-protocol.ts` writes it from the same schemas
 * `generated.rs` comes from, so `packages/protocol` stays the one source of truth.
 *
 * The walk throws, naming the schema path, on any construct whose output the table can't
 * describe, so a later schema change fails `check:daemon-native` instead of drifting. See
 * `docs/store/porting-guide.md` step 5.3b-1 for the refusal list.
 */

import { z } from "zod";

/** One shape the walk emits: `Copy`, or an object's field statics. */
type Node =
  | { kind: "copy" }
  | { kind: "object"; plan: Plan }
  | { kind: "array"; inner: Node }
  | { kind: "record"; inner: Node }
  | { kind: "nullable"; inner: Node }
  | { kind: "tagged"; key: string; options: { literal: string; shape: Node }[] };

interface Plan {
  readonly fields: { key: string; presence: Presence; shape: Node }[];
  readonly name: string;
}

type Presence = { kind: "required" } | { kind: "optional" } | { kind: "default"; text: string };

/** Zod 4's runtime definitions, as much of them as the walk reads. */
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  innerType?: z.ZodType;
  defaultValue?: unknown;
  coerce?: boolean;
  checks?: unknown[];
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

function fail(path: string, reason: string): never {
  throw new Error(`rust-protocol-shapes: ${path}: ${reason}`);
}

/** A Zod check that normalizes its input (`trim`, `toLowerCase`, `slugify`, ...). */
function normalizes(check: unknown): boolean {
  // oxlint-disable-next-line no-underscore-dangle -- Zod 4 keeps a check's kind here.
  const zod = (check as { _zod?: { def?: { check?: unknown } } })._zod;
  return zod?.def?.check === "overwrite";
}

function checkTypes(def: Def): void {
  if (def.coerce === true) throw new Error("coercion changes the value");
  for (const check of def.checks ?? []) {
    if (normalizes(check)) throw new Error("a check normalizes the value");
  }
}

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** A Rust string literal for `text`, including JSON text with quotes and escapes. */
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

/** One primitive default, as JSON text, or a refusal. */
function defaultText(path: string, value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  return fail(path, "a default is not a JSON primitive");
}

/**
 * Plans the shape of one schema. Objects are deduplicated by identity and named from the
 * first path that reaches them; every other construct is emitted inline.
 */
class Planner {
  readonly objects = new Map<z.ZodType, Plan>();
  readonly order: Plan[] = [];
  readonly used = new Set<string>();

  /** The object node for `schema`, filling its fields the first time it is reached. */
  object(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.objects.get(schema);
    if (existing !== undefined) return { kind: "object", plan: existing };
    const def = defOf(schema);
    if (def.catchall !== undefined)
      fail(path, "an object has a catchall (passthrough, strict or catchall)");
    const shape = def.shape;
    if (shape === undefined) fail(path, "an object has no shape");
    let unique = name;
    for (let suffix = 2; this.used.has(unique); suffix += 1) unique = `${name}_${suffix}`;
    this.used.add(unique);
    const plan: Plan = { name: unique, fields: [] };
    this.objects.set(schema, plan);
    this.order.push(plan);
    for (const [key, field] of Object.entries(shape)) {
      plan.fields.push(this.field(key, field, `${path}.${key}`));
    }
    return { kind: "object", plan };
  }

  /** One object field, applying `.optional()` or `.default()` as its presence. */
  private field(key: string, schema: z.ZodType, path: string): Plan["fields"][number] {
    const def = defOf(schema);
    let presence: Presence = { kind: "required" };
    let inner = schema;
    if (def.type === "optional") {
      presence = { kind: "optional" };
      inner = requireInner(def, path);
    } else if (def.type === "default") {
      presence = { kind: "default", text: defaultText(path, def.defaultValue) };
      inner = requireInner(def, path);
    }
    const innerType = defOf(inner).type;
    if (innerType === "optional" || innerType === "default")
      fail(path, `a field wraps .${innerType}() in or around its presence`);
    return { key, presence, shape: this.shape(inner, path) };
  }

  private shape(schema: z.ZodType, path: string): Node {
    const def = defOf(schema);
    try {
      checkTypes(def);
    } catch (error) {
      return fail(path, message(error));
    }
    switch (def.type) {
      case "string":
      case "number":
      case "boolean":
      case "null":
      case "enum":
      case "literal":
      case "unknown":
        return { kind: "copy" };
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
        const inner = this.shape(element, `${path}[]`);
        return inner.kind === "copy" ? { kind: "copy" } : { kind: "array", inner };
      }
      case "record": {
        const keyType = def.keyType;
        const valueType = def.valueType;
        if (keyType === undefined || valueType === undefined)
          return fail(path, "a record has no key or value type");
        const keyDef = defOf(keyType);
        if (keyDef.type !== "string") return fail(path, "a record's key is not a string");
        try {
          checkTypes(keyDef);
        } catch (error) {
          return fail(path, message(error));
        }
        const inner = this.shape(valueType, `${path}{value}`);
        return { kind: "record", inner };
      }
      case "nullable": {
        const inner = requireInner(def, path);
        const planned = this.shape(inner, path);
        return planned.kind === "copy" ? { kind: "copy" } : { kind: "nullable", inner: planned };
      }
      case "union": {
        const options = def.options;
        if (options === undefined) return fail(path, "a union has no options");
        if (def.discriminator !== undefined) return this.tagged(def.discriminator, options, path);
        for (const option of options) {
          const planned = this.shape(option, `${path}|`);
          if (planned.kind !== "copy")
            return fail(path, "a union has an option the table can't copy");
        }
        return { kind: "copy" };
      }
      case "optional":
      case "default":
        return fail(path, `.${def.type}() is not directly on an object field`);
      default:
        return fail(path, `the table can't describe \`${def.type}\``);
    }
  }

  private tagged(key: string, options: z.ZodType[], path: string): Node {
    const planned: { literal: string; shape: Node }[] = [];
    for (const [index, option] of options.entries()) {
      const optionPath = `${path}|${index}`;
      const def = defOf(option);
      if (def.type !== "object") return fail(optionPath, "a discriminated option is not an object");
      const field = def.shape?.[key];
      if (field === undefined) return fail(optionPath, `an option has no \`${key}\``);
      const fieldDef = defOf(field);
      if (fieldDef.type !== "literal")
        return fail(optionPath, `the discriminator \`${key}\` is not a literal`);
      const values = (fieldDef as { values?: unknown[] }).values;
      const value = values?.[0];
      if (typeof value !== "string")
        return fail(optionPath, `the discriminator \`${key}\` is not a string literal`);
      planned.push({ literal: JSON.stringify(value), shape: this.shape(option, optionPath) });
    }
    return { kind: "tagged", key, options: planned };
  }

  /** The deepest `Shape` nesting under `node`. */
  depth(node: Node): number {
    switch (node.kind) {
      case "copy":
        return 0;
      case "object": {
        return 1 + Math.max(0, ...node.plan.fields.map((field) => this.depth(field.shape)));
      }
      case "array":
      case "record":
      case "nullable":
        return 1 + this.depth(node.inner);
      case "tagged":
        return 1 + Math.max(0, ...node.options.map((option) => this.depth(option.shape)));
    }
  }
}

function requireInner(def: Def, path: string): z.ZodType {
  const inner = def.innerType;
  if (inner === undefined) return fail(path, `${def.type} has no inner type`);
  return inner;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shapeExpr(node: Node): string {
  switch (node.kind) {
    case "copy":
      return "Shape::Copy";
    case "object":
      return `Shape::Object(&${node.plan.name}_FIELDS)`;
    case "array":
      return `Shape::Array(&${shapeExpr(node.inner)})`;
    case "record":
      return `Shape::Record(&${shapeExpr(node.inner)})`;
    case "nullable":
      return `Shape::Nullable(&${shapeExpr(node.inner)})`;
    case "tagged": {
      const options = node.options
        .map((option) => `(${rustString(option.literal)}, ${shapeExpr(option.shape)})`)
        .join(", ");
      return `Shape::Tagged { key: ${rustString(node.key)}, options: &[${options}] }`;
    }
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

/**
 * The source of `shapes.rs` for the given roots, keyed by the Rust static's name. Throws,
 * naming the schema path, when a root reaches a construct the table can't describe.
 */
export function shapesSource(roots: Record<string, z.ZodType>): string {
  const planner = new Planner();
  const rootNodes: [string, Node][] = [];
  for (const [name, schema] of Object.entries(roots)) {
    const def = defOf(schema);
    if (def.type !== "object") fail(name, "a root is not an object");
    const node = planner.object(schema, name, name);
    rootNodes.push([name, node]);
  }
  const depth = Math.max(0, ...rootNodes.map(([, node]) => planner.depth(node)));
  const lines: string[] = [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Generated by scripts/generate-rust-protocol.ts -- do not edit.",
    "// The shape table for the thread column encoders (porting guide 5.3b): what each Zod",
    `// parse keeps, in schema order, with the defaults it inserts. Depth ${depth}: the deepest`,
    "// Shape nesting, which bounds the walk; the walk follows this table, never the value.",
    "",
    "use crate::shape::{Field, Presence, Shape};",
    "",
  ];
  for (const plan of planner.order) {
    lines.push(`static ${plan.name}_FIELDS: [Field; ${plan.fields.length}] = [`);
    for (const field of plan.fields) {
      lines.push(
        `    Field { key: ${rustString(field.key)}, presence: ${presenceExpr(
          field.presence,
        )}, shape: ${shapeExpr(field.shape)} },`,
      );
    }
    lines.push("];", "");
  }
  for (const [name, node] of rootNodes)
    lines.push(`pub static ${name}: Shape = ${shapeExpr(node)};`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}
