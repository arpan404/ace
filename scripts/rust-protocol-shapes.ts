// SPDX-License-Identifier: Apache-2.0

/*
 * Writes the `ace-protocol/src/shapes/` table (porting guide 5.3b): what each Zod object
 * keeps, with its defaults, split by root. The walk throws, naming the path, on any
 * construct whose output the table can't describe.
 */

import { z } from "zod";

/** One shape the walk emits: `Copy`, or an object's field statics. */
type Extra = "strip" | "reject" | "keep" | "shaped";

type Node =
  | { kind: "copy" }
  | { kind: "object"; plan: Plan; extra: Extra; rest?: Node }
  | { kind: "trim" }
  | { kind: "later"; name: string; root: string }
  | { kind: "array"; inner: Node }
  | { kind: "record"; inner: Node }
  | { kind: "nullable"; inner: Node }
  | { kind: "tagged"; key: string; options: { literal: string; shape: Node }[] }
  | { kind: "oneOf"; options: Node[] };

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
  left?: z.ZodType;
  right?: z.ZodType;
  items?: z.ZodType[];
}

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

function fail(path: string, reason: string): never {
  throw new Error(`rust-protocol-shapes: ${path}: ${reason}`);
}

/** A check that rewrites its input, as `z.string().trim()` does. */
function overwrite(check: unknown): ((payload: { value: unknown }) => void) | undefined {
  // Zod 4 keeps a check's kind and function on `_zod`.
  const zod = (check as Record<string, { def?: { check?: unknown }; check?: unknown }>)["_zod"];
  if (zod?.def?.check !== "overwrite") return undefined;
  const run = zod.check;
  return typeof run === "function" ? (run as (payload: { value: unknown }) => void) : undefined;
}

/** What an overwrite check does to a string, or `null` when the table can't express it. */
function normalization(check: unknown): "trim" | null {
  const run = overwrite(check);
  if (run === undefined) return null;
  const probe = { value: "\u{feff} \t x \n " };
  try {
    run(probe);
  } catch {
    return null;
  }
  return probe.value === "x" ? "trim" : null;
}

/** The check kinds a value can carry, refusing any that rewrites it in a way we can't. */
function checkTypes(def: Def): boolean {
  if (def.coerce === true) throw new Error("coercion changes the value");
  let trim = false;
  for (const check of def.checks ?? []) {
    if (overwrite(check) === undefined) continue;
    if (normalization(check) === "trim") trim = true;
    else throw new Error("a check rewrites the value in a way the table can't describe");
  }
  return trim;
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

/** A default, as the JSON text Zod inserts: the literal as written, key order included. */
function defaultText(path: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? fail(path, "a default is undefined");
  } catch {
    return fail(path, "a default is not JSON");
  }
}

/**
 * The schema whose output a `.meta({ "x-ace-json-input" })` names, when the transform's own
 * output can't be described: `records()` keeps every own key, and the hello's `lastClose`
 * turns an unparsable report into `undefined`.
 */
function metaInput(schema: z.ZodType): z.ZodType | undefined {
  const meta = (schema as unknown as { meta?: () => Record<string, unknown> }).meta?.();
  const input = meta?.["x-ace-json-input"];
  if (input === null || typeof input !== "object") return undefined;
  return (input as { def?: unknown }).def === undefined ? undefined : (input as z.ZodType);
}

/**
 * Plans the shape of one schema. Objects are deduplicated by identity and named from the
 * first path that reaches them; every other construct is emitted inline.
 */
class Planner {
  readonly objects = new Map<z.ZodType, Plan>();
  readonly order: Plan[] = [];
  readonly used = new Set<string>();
  /** Lazy schemas, planned once: their statics hold a `Shape` that may name itself. */
  readonly lazies = new Map<z.ZodType, { name: string; node: Node | undefined; root: string }>();
  root = "";

  /** The object node for `schema`, filling its fields the first time it is reached. */
  object(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.objects.get(schema);
    if (existing !== undefined) {
      return {
        kind: "object",
        plan: existing,
        extra: defOf(schema).catchall === undefined ? "strip" : extraOf(schema, path),
      };
    }
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

  /** A recursive schema: one static per lazy node, referenced wherever it is reached. */
  private lazy(schema: z.ZodType, name: string, path: string): Node {
    const existing = this.lazies.get(schema);
    if (existing !== undefined) return { kind: "later", name: existing.name, root: existing.root };
    const getter = (defOf(schema) as unknown as { getter?: () => z.ZodType }).getter;
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
    // The outermost wrapper decides an absent key's fate: `.optional()` on a default keeps
    // the key absent, `.default()` on an optional inserts the default.
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
    const def = defOf(schema);
    let trims = false;
    try {
      trims = checkTypes(def);
    } catch (error) {
      return fail(path, message(error));
    }
    // A transform that keeps a schema we can describe names it: `records()` keeps the
    // record's own keys with the value shape it names, and the hello's `lastClose` reads a
    // report that doesn't parse as absent. Walk the named schema.
    const named = metaInput(schema);
    if (named !== undefined) return this.shape(named, path);
    switch (def.type) {
      case "string":
        return trims ? { kind: "trim" } : { kind: "copy" };
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
      case "tuple": {
        const items = def.items;
        if (items === undefined) return fail(path, "a tuple has no items");
        const planned = items.map((item, index) => this.shape(item, `${path}[${index}]`));
        return planned.every((item) => item.kind === "copy")
          ? { kind: "copy" }
          : { kind: "array", inner: mergeTuple(planned, path) };
      }
      case "record": {
        const keyType = def.keyType;
        const valueType = def.valueType;
        if (keyType === undefined || valueType === undefined)
          return fail(path, "a record has no key or value type");
        const keyDef = defOf(keyType);
        if (keyDef.type !== "string" && keyDef.type !== "enum")
          return fail(path, "a record's key is not a string");
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
        const planned = options.map((option, index) => this.shape(option, `${path}|${index}`));
        if (planned.every((option) => option.kind === "copy")) return { kind: "copy" };
        return { kind: "oneOf", options: planned };
      }
      case "intersection": {
        const left = def.left;
        const right = def.right;
        if (left === undefined || right === undefined)
          return fail(path, "an intersection has no sides");
        return this.merge(this.shape(left, `${path}&0`), this.shape(right, `${path}&1`), path);
      }
      case "pipe":
        return fail(path, "a pipe names no input schema (x-ace-json-input)");
      case "transform":
        return fail(path, "a transform names no input schema (x-ace-json-input)");
      case "catch":
        return fail(path, "a catch has a fallback the table can't choose");
      case "custom":
        return fail(path, "a custom check names no schema");
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
      // One tag with two shapes (a message and a nested union's members): the first the value
      // fits, as Zod tries its options.
      existing.shape =
        existing.shape.kind === "oneOf"
          ? { kind: "oneOf", options: [...existing.shape.options, option.shape] }
          : { kind: "oneOf", options: [existing.shape, option.shape] };
    };
    for (const [index, option] of options.entries()) {
      const optionPath = `${path}|${index}`;
      const def = defOf(option);
      // A union among the options (`ClientMessage` spreads several, and some are plain unions
      // of objects that carry the same discriminator): its options are this union's options.
      if (def.type === "union") {
        // The inner union's own discriminator (`operation` under an `action`) is just another
        // field of each option; the outer key decides the option here.
        for (const nested of this.tagged(key, def.options ?? [], optionPath).options) add(nested);
        continue;
      }
      if (def.type !== "object") return fail(optionPath, `a discriminated option is a ${def.type}`);
      const field = def.shape?.[key];
      if (field === undefined) return fail(optionPath, `an option has no \`${key}\``);
      const fieldDef = defOf(field);
      const values =
        fieldDef.type === "enum"
          ? (fieldDef as unknown as { entries?: Record<string, string> }).entries === undefined
            ? []
            : Object.values((fieldDef as unknown as { entries: Record<string, string> }).entries)
          : fieldDef.type === "literal"
            ? ((fieldDef as { values?: unknown[] }).values ?? [])
            : fail(optionPath, `the discriminator \`${key}\` is not a literal or enum`);
      if (values.length === 0)
        return fail(optionPath, `the discriminator \`${key}\` has no literal value`);
      const shape = this.shape(option, optionPath);
      for (const value of values) {
        const literal = JSON.stringify(value) ?? fail(optionPath, "a tag is not JSON");
        add({ literal, shape });
      }
    }
    return { kind: "tagged", key, options: planned };
  }

  /**
   * `a.and(b)`: Zod's output is `{ ...left, ...right }`, so the left object's keys keep their
   * place and the right object's follow; a tagged left merges each option.
   */
  merge(a: Node, b: Node, path: string): Node {
    if (a.kind === "copy") return b.kind === "copy" ? { kind: "copy" } : b;
    if (b.kind === "copy") return a;
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

  /** The deepest `Shape` nesting under `node`. */
  depth(node: Node): number {
    switch (node.kind) {
      case "copy":
      case "trim":
      case "later":
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
      case "oneOf":
        return 1 + Math.max(0, ...node.options.map((option) => this.depth(option)));
    }
  }
}

/** A loose object keeps unnamed keys, a strict one rejects them, a plain one drops them. */
function extraOf(schema: z.ZodType, path: string): Extra {
  const catchall = defOf(schema).catchall;
  if (catchall === undefined) return "strip";
  const type = defOf(catchall).type;
  if (type === "never") return "reject";
  if (type === "unknown") return "keep";
  return fail(path, `an object has a ${type} catchall`);
}

function extraExpr(extra: Extra): string {
  if (extra === "strip") return "Extra::Strip";
  if (extra === "reject") return "Extra::Reject";
  return "Extra::Keep";
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
    case "object": {
      const name = `${node.plan.name}_FIELDS`;
      const fields =
        node.plan.file === file ? `${name}` : `crate::shapes::${node.plan.file}::${name}`;
      const extra =
        node.extra === "shaped" && node.rest !== undefined
          ? `Extra::Shaped(&${shapeExpr(node.rest, file)})`
          : extraExpr(node.extra);
      return `Shape::Object { fields: &${fields}, extra: ${extra} }`;
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
    case "oneOf": {
      const options = node.options.map((option) => shapeExpr(option, file)).join(", ");
      return `Shape::OneOf(&[${options}])`;
    }
    case "trim":
      return "Shape::Trim";
    case "later": {
      const lazyFile = `${snake(node.root).toLowerCase()}_lazy`;
      return lazyFile === file
        ? `Shape::Later(&${node.name})`
        : `Shape::Later(&crate::shapes::${lazyFile}::${node.name})`;
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
    planner.root = name;
    rootNodes.push([name, planner.shape(schema, name)]);
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
    // A root that is a union or a primitive has no plan of its own: its own file holds the
    // static that names the shapes its options use.
    const file = `${snake(root).toLowerCase()}_root`;
    files.push({ file, plans: [], roots: [entry] });
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
      "use crate::shape::{Extra, Field, Presence, Shape};",
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
      if (
        entry.node !== undefined &&
        chunk.file === `${snake(entry.root).toLowerCase()}_lazy` &&
        lazyFiles.get(chunk.file)?.includes(entry.name)
      ) {
        lines.push(`pub static ${entry.name}: Shape = ${shapeExpr(entry.node, chunk.file)};`, "");
        lazyFiles.set(
          chunk.file,
          (lazyFiles.get(chunk.file) ?? []).filter((name) => name !== entry.name),
        );
      }
    result.set(`${chunk.file}.rs`, `${lines.join("\n").trimEnd()}\n`);
  }
  return result;
}
