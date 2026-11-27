// SPDX-License-Identifier: Apache-2.0

/*
 * Writes the `ace-protocol/src/shapes/` table (porting guide 5.3b): what each Zod object
 * keeps, with its defaults, split by root. The walk throws, naming the path, on any
 * construct whose output the table can't describe.
 */

import { z } from "zod";

/** One shape the walk emits: `Copy`, or an object's field statics. */
type Node =
  | { kind: "copy" }
  | { kind: "object"; plan: Plan }
  | { kind: "open"; plan: Plan }
  | { kind: "array"; inner: Node }
  | { kind: "record"; inner: Node }
  | { kind: "nullable"; inner: Node }
  | { kind: "tagged"; key: string; options: { literal: string; shape: Node }[] };

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

/** A literal or enum's string values, whichever the schema uses. */
function tagValues(field: z.ZodType): unknown[] {
  const def = defOf(field);
  if (def.type === "literal") return (def as { values?: unknown[] }).values ?? [];
  if (def.type === "enum") {
    const entries = (def as { entries?: Record<string, unknown> }).entries ?? {};
    return Object.values(entries);
  }
  return [];
}

/** The one string-literal key every object option shares, when there is exactly one. */
function sharedLiteralKey(options: z.ZodType[]): string | undefined {
  let shared: string[] | undefined;
  for (const option of options) {
    const def = defOf(option);
    if (def.type !== "object" || def.shape === undefined) return undefined;
    const literals = Object.entries(def.shape)
      .filter(([, field]) => {
        const fieldDef = defOf(field);
        return (
          (fieldDef.type === "literal" || fieldDef.type === "enum") &&
          tagValues(field).every((value) => typeof value === "string")
        );
      })
      .map(([key]) => key);
    shared = shared === undefined ? literals : shared.filter((key) => literals.includes(key));
    if (shared.length === 0) return undefined;
  }
  if (shared === undefined || shared.length === 0) return undefined;
  // A tag that repeats a value across options would not tell them apart; take the first that
  // does, so the table keeps the same choice on every build.
  for (const key of shared) {
    const values = new Set<string>();
    for (const option of options) {
      const field = defOf(option).shape?.[key];
      const literals = field === undefined ? [] : tagValues(field);
      if (literals.length !== 1 || typeof literals[0] !== "string") return undefined;
      if (values.has(literals[0])) break;
      values.add(literals[0]);
    }
    if (values.size === options.length) return key;
  }
  return undefined;
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
  // An object or array default (an empty `options`, a list) is inserted as that JSON value, in
  // the order the literal wrote it, which is what Zod's default hands back.
  if (typeof value === "object")
    return JSON.stringify(value, (_key, entry) =>
      typeof entry === "number" && !Number.isFinite(entry) ? undefined : entry,
    ).replace(undefined, () => {
      fail(path, "a default is not JSON");
      return "";
    });
  return fail(path, "a default is not a JSON value");
}

/**
 * Plans the shape of one schema. Objects are deduplicated by identity and named from the
 * first path that reaches them; every other construct is emitted inline.
 */
class Planner {
  readonly objects = new Map<z.ZodType, Plan>();
  readonly order: Plan[] = [];
  readonly used = new Set<string>();
  root = "";

  /** The object node for `schema`, filling its fields the first time it is reached. */
  object(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.objects.get(schema);
    if (existing !== undefined) return { kind: "object", plan: existing };
    const def = defOf(schema);
    // A loose object (`passthrough`) keeps every other key after its fields; a strict object's
    // catchall is `never` and keeps none, so it is an ordinary object here.
    let open = false;
    if (def.catchall !== undefined) {
      const catchall = defOf(def.catchall).type;
      if (catchall === "never") open = false;
      else if (catchall === "unknown") open = true;
      else fail(path, "an object has a catchall the table can't describe");
    }
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
    return { kind: open ? "open" : "object", plan };
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
    // `.partial()` and `.extend()` can wrap an already-optional field again. The shape walk
    // follows what a parse keeps: nested `.optional()` stays optional, and a `.default()` under
    // an optional never applies to an absent key (Zod's optional returns undefined first), so
    // both unwrap to the presence already read, with the innermost schema's shape.
    for (;;) {
      const innerType = defOf(inner).type;
      if (innerType === "optional" || innerType === "default") {
        inner = requireInner(defOf(inner), path);
        continue;
      }
      break;
    }
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
        // A plain union whose options are objects tagged by one shared string literal (a status,
        // a kind) parses exactly like a discriminated union on that key: the options' literals
        // are disjoint, so Zod's order picks the one whose literal matches.
        const key = sharedLiteralKey(options);
        if (key !== undefined) return this.tagged(key, options, path);
        // A union whose options the table can't describe (a transform, a loose object, an
        // option order only Zod can run) is copied as it came: no stripping inside it. The
        // decode sites treat it as stored data, and `check:wire-fixtures` compares the bytes
        // of the samples that reach it.
        return { kind: "copy" };
      }
      case "pipe":
      case "transform":
        // A transform's output can't be described from its declaration. The stored decoder
        // applies the legacy fixes it needs (T4a) and copies the rest as stored, a recorded
        // difference from Zod's parse inside that subtree.
        return { kind: "copy" };
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
      // A tag is one literal or an enum of literals (`kind: z.enum(["browser", "notebook"])`).
      if (fieldDef.type !== "literal" && fieldDef.type !== "enum")
        return fail(optionPath, `the discriminator \`${key}\` is not a literal or enum`);
      const values = tagValues(field);
      if (values.length === 0)
        return fail(optionPath, `the discriminator \`${key}\` has no literal value`);
      const shape = this.shape(option, optionPath);
      for (const value of values) {
        if (typeof value !== "string")
          return fail(optionPath, `the discriminator \`${key}\` is not a string literal`);
        const literal = JSON.stringify(value);
        if (planned.some((plannedOption) => plannedOption.literal === literal))
          fail(path, `the discriminated union has a duplicate tag ${literal}`);
        planned.push({ literal, shape });
      }
    }
    return { kind: "tagged", key, options: planned };
  }

  /** The deepest `Shape` nesting under `node`. */
  depth(node: Node): number {
    switch (node.kind) {
      case "copy":
        return 0;
      case "object":
      case "open": {
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

function shapeExpr(node: Node, file: string): string {
  switch (node.kind) {
    case "copy":
      return "Shape::Copy";
    case "object":
    case "open": {
      const name = `${node.plan.name}_FIELDS`;
      const kind = node.kind === "open" ? "Open" : "Object";
      return node.plan.file === file
        ? `Shape::${kind}(&${name})`
        : `Shape::${kind}(&crate::shapes::${node.plan.file}::${name})`;
    }
    case "array":
      return `Shape::Array(&${shapeExpr(node.inner, file)})`;
    case "record":
      return `Shape::Record(&${shapeExpr(node.inner, file)})`;
    case "nullable":
      return `Shape::Nullable(&${shapeExpr(node.inner, file)})`;
    case "tagged": {
      const options = node.options
        .map((option) => `(${rustString(option.literal)}, ${shapeExpr(option.shape, file)})`)
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
export function shapesSource(roots: Record<string, z.ZodType>): Map<string, string> {
  const planner = new Planner();
  const rootNodes: [string, Node][] = [];
  const names = Object.keys(roots);
  for (const name of names) {
    const schema = roots[name];
    const def = defOf(schema);
    if (def.type !== "object") fail(name, "a root is not an object");
    planner.root = name;
    rootNodes.push([name, planner.object(schema, name, name)]);
  }
  const depth = Math.max(0, ...rootNodes.map(([, node]) => planner.depth(node)));
  const files = chunks(names, planner.order);
  for (const entry of rootNodes) {
    const node = entry[1];
    if (node.kind === "object" || node.kind === "open")
      files.find((chunk) => chunk.file === node.plan.file)?.roots.push(entry);
  }
  const head = [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Generated by scripts/generate-rust-protocol.ts -- do not edit.",
    "// The shape table for the thread column encoders (porting guide 5.3b).",
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
    );
  const result = new Map([["mod.rs", `${module.join("\n").trimEnd()}\n`]]);
  for (const chunk of files) {
    const lines = [
      ...head,
      `// Part ${chunk.file}.`,
      "use crate::shape::{Field, Presence, Shape};",
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
    result.set(`${chunk.file}.rs`, `${lines.join("\n").trimEnd()}\n`);
  }
  return result;
}
