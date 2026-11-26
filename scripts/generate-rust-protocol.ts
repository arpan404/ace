// SPDX-License-Identifier: Apache-2.0

/*
 * Generates `native/daemon/crates/ace-protocol/src/generated.rs` from the
 * JSON Schema of the `@ace/protocol` schemas the engine uses
 * (`z.toJSONSchema`) via `typify` (ADR 0223 §2). `packages/protocol` stays
 * the one source of truth: the output is committed, never hand-edited, and
 * `check:daemon-native` regenerates and fails on a diff.
 *
 *   bun scripts/generate-rust-protocol.ts [--check]
 *
 * `--check` regenerates to a temporary file and fails naming it when it
 * differs from the committed output. Each root below is a schema the engine
 * reads or writes (ADR 0223 §2 names the set); shared schemas referenced
 * from several roots become one `$defs` entry (`reused: "ref"`), titled so
 * `typify` emits one Rust type per shared schema instead of a copy per use.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BrowserBackendClientMessage,
  ClientMessage,
  ServerMessage,
  UserBrowserExtensionMessage,
  CoreClientMessage,
  CoreServerMessage,
  KnownThreadStatus,
  ThreadStatus,
  AccessMode,
  AcpIdentity,
  AcpSessionSupport,
  AgentItem,
  AgentStatus,
  Capabilities,
  CatalogModel,
  Command,
  CommandPayload,
  ContentPart,
  EffortLevel,
  Event,
  EventPayload,
  ExecutionOptions,
  ExecutionSelection,
  GoalChange,
  InteractionResolution,
  MessageOrigin,
  ModelEffort,
  ModelSource,
  ModelTier,
  PermissionMode,
  ProviderKind,
  ScreenKey,
  ThreadId,
  ThreadClientFields,
  ThreadDetails,
  ThreadProviderMetadata,
} from "@ace/protocol";
import { shapesSource } from "./rust-protocol-shapes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The schemas the engine reads and writes, each emitted as one Rust type. */
const roots: Record<string, z.ZodType> = {
  // Flattened into one root per message type below; deleted from the typify document after.
  ClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
  ServerMessage,
  EventPayload,
  Event,
  AgentItem,
  ContentPart,
  MessageOrigin,
  AgentStatus,
  KnownThreadStatus,
  ThreadStatus,
  CommandPayload,
  Command,
  GoalChange,
  InteractionResolution,
  ExecutionOptions,
  ExecutionSelection,
  Capabilities,
  PermissionMode,
  AcpIdentity,
  AcpSessionSupport,
  AccessMode,
  ProviderKind,
  CatalogModel,
  CatalogRaw: CatalogModel.shape.raw,
  ModelEffort,
  ModelTier,
  ModelSource,
  EffortLevel,
  ThreadId,
};

const combined = z.object(roots as Record<string, z.ZodType>);
const rawSchema = z.toJSONSchema(combined, {
  unrepresentable: "any",
  io: "output",
  reused: "ref",
  override: ({ zodSchema, jsonSchema }) => {
    if (zodSchema === ScreenKey) {
      // `typify` cannot name this enum's variants (`A` and `a` sanitize
      // alike), so the Rust form stays an open string, which is also the
      // lenient decoding (rule 8): unknown keys stay readable, and the
      // title below only marks the spot (nested titles do not survive
      // typify's merges, so uses read `String`). The closed list lives in
      // `screen-keys.ts`.
      for (const key of Object.keys(jsonSchema)) delete jsonSchema[key as keyof typeof jsonSchema];
      jsonSchema.type = "string";
      jsonSchema.title = "ScreenKey";
      return;
    }
    if (zodSchema === ModelTier.shape.speed.unwrap()) {
      // A tier's speed is a known speed or a provider's newer one kept as sent,
      // so it is an open string on the wire. `typify` renders the union as a
      // flattened struct a bare string cannot deserialize into; the open string
      // is both the wire shape and the lenient read (rule 8).
      for (const key of Object.keys(jsonSchema)) delete jsonSchema[key as keyof typeof jsonSchema];
      jsonSchema.type = "string";
      jsonSchema.title = "ModelTierSpeed";
      return;
    }
    for (const [name, rootSchema] of Object.entries(roots)) {
      if (zodSchema === rootSchema) {
        jsonSchema.title = name;
        return;
      }
    }
  },
});

/*
 * What `typify` cannot turn into Rust types is dropped before generation.
 * None of it changes a Rust type: `serde` does not enforce lengths,
 * patterns or formats, so the TypeScript's runtime-only checks have no
 * structural counterpart. Kept: `const` and `enum`, which choose variants.
 * - `minLength`, `maxLength`, `pattern`: typify makes a validated newtype
 *   that needs a name for every inline use and a `regress` dependency for
 *   patterns; an inline constrained string inside an enum variant panics.
 * - `format`: typify maps unknown formats (`ace-whatwg-url`) the same
 *   constrained way, and known ones to non-`String` natives.
 * - `propertyNames`: a merge assertion in typify rejects it outright; key
 *   constraints have no Rust map counterpart.
 * - `not`: exclusion constraints (`.refine` with a `not` pattern) have no
 *   Rust type counterpart; typify renders them as an empty, uninhabited enum.
 * - `additionalProperties: false`: typify turns it into
 *   `deny_unknown_fields`, which rule 8 forbids. The TypeScript never
 *   enforced it either (`z.object` strips unknown keys at runtime), so the
 *   Rust structs ignore unknown fields exactly like the decoders do today.
 *   Keeping them as raw stays the frame layer's job (`Box<RawValue>`).
 */
function stripValidation(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripValidation(item);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    delete record.minLength;
    delete record.maxLength;
    delete record.pattern;
    delete record.format;
    delete record.propertyNames;
    delete record.additionalProperties;
    delete record.not;
    // A tuple's `items: false` only forbids extra elements; typify reads it as the element
    // schema and emits an empty enum. The prefix items are the element types.
    if (record.items === false && Array.isArray(record.prefixItems)) delete record.items;
    for (const value of Object.values(record)) stripValidation(value);
  }
}

function renameTitledDefs(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return;
  const defs = (document as Record<string, unknown>).$defs;
  if (defs === null || typeof defs !== "object" || Array.isArray(defs)) return;
  const table = defs as Record<string, unknown>;
  const entries = Object.entries(table);
  const titles = new Map<string, string>();
  for (const [key, def] of entries) {
    if (def !== null && typeof def === "object" && !Array.isArray(def)) {
      const title = (def as Record<string, unknown>).title;
      if (typeof title === "string" && title.length > 0) titles.set(key, title);
    }
  }
  // Two defs may share a title; the second keeps a suffixed name instead of overwriting the
  // first (which used to leave refs dangling and silently bind one schema's type to another).
  const final = new Map<string, string>();
  const taken = new Set<string>();
  for (const [key, def] of entries) {
    let name = titles.get(key) ?? key;
    const base = name;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`;
    taken.add(name);
    final.set(key, name);
    void def;
  }
  if (entries.every(([key]) => final.get(key) === key)) return;
  const renamed = new Map<string, string>();
  for (const [key, name] of final) if (name !== key) renamed.set(key, name);
  const rebuilt: Record<string, unknown> = {};
  for (const [key, def] of entries) rebuilt[final.get(key) ?? key] = def;
  (document as Record<string, unknown>).$defs = rebuilt;
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) rewrite(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      const object = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(object)) {
        if (key === "$ref" && typeof value === "string") {
          const name = value.replace(/^#\/\$defs\//, "");
          const target = final.get(name);
          if (target !== undefined) object[key] = `#/$defs/${target}`;
        } else rewrite(value);
      }
    }
  };
  rewrite(document);
}

function isNullBranch(branch: unknown): boolean {
  if (branch === null || typeof branch !== "object" || Array.isArray(branch)) return false;
  const record = branch as Record<string, unknown>;
  if (record.$ref !== undefined) return false;
  if (record.type === "null") return true;
  if (Array.isArray(record.enum) && record.enum.length === 1 && record.enum[0] === null)
    return true;
  return record.const === null;
}

function hoistNullableBranches(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return;
  const defs = (document as Record<string, unknown>).$defs;
  if (defs === null || typeof defs !== "object" || Array.isArray(defs)) return;
  const table = defs as Record<string, unknown>;
  for (const [key, def] of Object.entries(table)) {
    if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
    const record = def as Record<string, unknown>;
    for (const combinator of ["anyOf", "oneOf"]) {
      const branches = record[combinator];
      if (!Array.isArray(branches) || branches.length !== 2) continue;
      const [first, second] = branches as unknown[];
      const inner = isNullBranch(first) ? second : isNullBranch(second) ? first : undefined;
      if (
        inner === undefined ||
        inner === null ||
        typeof inner !== "object" ||
        Array.isArray(inner) ||
        (inner as Record<string, unknown>).$ref !== undefined
      )
        continue;
      const innerKey = `${key}Inner`;
      table[innerKey] = inner;
      record[combinator] = (branches as unknown[]).map((branch) =>
        branch === inner ? { $ref: `#/$defs/${innerKey}` } : branch,
      );
    }
  }
}
const schema = JSON.parse(JSON.stringify(rawSchema)) as unknown;
if (process.env.ACE_PROTOCOL_RAW !== undefined)
  writeFileSync(process.env.ACE_PROTOCOL_RAW, JSON.stringify(schema));
stripValidation(schema);
/*
 * `typify` only recognises a discriminated union when each branch's tag property is a
 * constant *inline*; with `reused: "ref"` a shared `type` string is a `$ref`, so every union
 * would stay untagged, and serde would try variants by shape (losing the fields of the right
 * one). Inline a reference whose target is a constant, and only those.
 */
inlineConstantRefs(schema);
/*
 * A union of string enums (`SettingsKey` is one enum plus another) is untagged to typify and
 * becomes a flattened struct that cannot serialize a string back. Merge all-constant string
 * branches into one enum before generation.
 */
mergePrimitiveUnions(schema);
/*
 * `typify` names an inline object or enum after its parent and property (`EventPayloadState`),
 * so two messages' `state` enums become one Rust type and the second silently reuses the
 * first. Name every inline object and enum after its whole path instead, so each one is its
 * own generated type.
 */
splitEnumTags(schema);
titleInlineSchemas(schema);
/*
 * `typify` names `$defs` entries by their key, not their `title`. Point the
 * titled entries at their titles so the Rust types are named for the schema
 * (`ContentPart`, not `__schema128`); untitled entries keep their generated
 * keys. Refs are rewritten to match.
 */
renameTitledDefs(schema);
/*
 * `typify` 0.8 converts a named `$defs` entry shaped `anyOf`/`oneOf` with a
 * null branch by naming both the nullable wrapper and an inline
 * object/enum branch after the entry, so neither compiles. Hoist such a
 * branch into its own entry: the wrapper keeps the entry's name, the branch
 * takes `<entry>Inner`. Semantics do not change; the branch was used once.
 */
hoistNullableBranches(schema);

/*
 * Typify turns a `oneOf` into one untagged Rust enum, whose variants serde tries by shape:
 * two messages with the same fields decode as whichever comes first, and the body is lost.
 * The wire's two unions are therefore flattened into one root per message type, named for it,
 * so a decoder dispatches on the envelope's `type` and reads exactly that message's type.
 * `wireMessages` is what `wire.rs` is generated from.
 */
interface WireMessage {
  type: string;
  name: string;
}
const wireMessages: { client: WireMessage[]; server: WireMessage[] } = { client: [], server: [] };
{
  const properties = (schema as Record<string, unknown>).properties as Record<string, unknown>;
  for (const [union, direction] of [
    ["ClientMessage", "client"],
    ["BrowserBackendClientMessage", "client"],
    ["UserBrowserExtensionMessage", "client"],
    ["ServerMessage", "server"],
  ] as const) {
    const unionRoot = properties[union] as Record<string, unknown>;
    const oneOf = (unionRoot.oneOf ?? unionRoot.anyOf) as unknown[] | undefined;
    if (!Array.isArray(oneOf))
      throw new Error(
        `${union}: no oneOf/anyOf branches to flatten (${Object.keys(unionRoot).join(", ")})`,
      );
    delete properties[union];
    const prefix = direction === "client" ? "Client" : "Server";
    const found = new Map<string, { name: string; schemas: unknown[] }>();
    for (const branch of oneOf) {
      for (const [typeName, named] of flattenBranch(schema, branch, prefix, direction)) {
        const entry = found.get(typeName);
        if (entry === undefined) found.set(typeName, { name: named.name, schemas: [named.schema] });
        else entry.schemas.push(named.schema);
      }
    }
    for (const [typeName, entry] of found) {
      // One `type` may name two shapes (a request and a reply that share it): Zod tries its
      // options in order, so the type decodes as an untagged union of the same shapes.
      const schemas = [
        ...new Map(
          entry.schemas.map((candidate) => [JSON.stringify(candidate), candidate]),
        ).values(),
      ];
      properties[entry.name] =
        schemas.length === 1
          ? schemas[0]
          : { title: entry.name, oneOf: schemas.map((candidate) => ({ allOf: [candidate] })) };
      wireMessages[direction].push({ type: typeName, name: entry.name });
    }
  }
}

/** One branch of a wire union, as the root typify should give a name. */
function flattenBranch(
  document: unknown,
  branch: unknown,
  prefix: string,
  direction: string,
): [string, { name: string; schema: unknown }][] {
  const types = branchTypes(document, branch);
  if (types.length === 0) {
    const record = branch as Record<string, unknown> | null;
    const nested = record?.oneOf ?? record?.anyOf;
    if (record !== null && typeof record === "object" && Array.isArray(nested))
      return nested.flatMap((option) => flattenBranch(document, option, prefix, direction));
    throw new Error(`${direction} union: a branch has no \`type\` const to name it`);
  }
  return types.map((typeName) => {
    const name = `${prefix}${pascal(typeName)}`;
    const record = branch as Record<string, unknown>;
    const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    if (copy.properties !== null && typeof copy.properties === "object") {
      const properties = copy.properties as Record<string, unknown>;
      if (properties.type !== undefined) properties.type = { type: "string", const: typeName };
    }
    delete copy.title;
    const named =
      typeof record.$ref === "string" ? { title: name, allOf: [copy] } : { ...copy, title: name };
    return [typeName, { name, schema: named }] as [string, { name: string; schema: unknown }];
  });
}

/** `browser.backend.register` → `BrowserBackendRegister`. */
function pascal(type_: string): string {
  const parts = type_.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  const name = parts.map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : `T${name}`;
}

/** The `type` values one branch carries: a `const`, an `enum`, or a nested union. */
function branchTypes(document: unknown, branch: unknown): string[] {
  if (branch === null || typeof branch !== "object") return [];
  const record = branch as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const defs = (document as Record<string, unknown>).$defs;
    const name = record.$ref.replace(/^#\/\$defs\//, "");
    if (defs !== null && typeof defs === "object")
      return branchTypes(document, (defs as Record<string, unknown>)[name]);
    return [];
  }
  const properties =
    record.properties !== null && typeof record.properties === "object"
      ? (record.properties as Record<string, unknown>)
      : undefined;
  const typeField = properties?.type as Record<string, unknown> | undefined;
  if (typeField !== undefined && typeof typeField === "object") {
    const ref = typeField.$ref;
    if (typeof ref === "string") return branchTypes(document, typeField);
    if (typeof typeField.const === "string") return [typeField.const];
    if (Array.isArray(typeField.enum))
      return typeField.enum.filter((value): value is string => typeof value === "string");
  }
  if (typeof record.const === "string") return [record.const];
  const nested = record.oneOf ?? record.anyOf;
  if (Array.isArray(nested)) return nested.flatMap((option) => branchTypes(document, option));
  return [];
}

/** Replace every `$ref` to a constant schema with that schema, in place. */
function inlineConstantRefs(document: unknown): void {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return;
  const defs = (document as Record<string, unknown>).$defs;
  const table =
    defs !== null && typeof defs === "object" ? (defs as Record<string, unknown>) : undefined;
  const inline = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) inline(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === "string" && table !== undefined) {
      const name = ref.replace(/^#\/\$defs\//, "");
      const target = table[name];
      if (
        target !== null &&
        typeof target === "object" &&
        !Array.isArray(target) &&
        (target as Record<string, unknown>).const !== undefined
      ) {
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, JSON.parse(JSON.stringify(target)));
        return;
      }
    }
    for (const value of Object.values(record)) inline(value);
  };
  inline(document);
}

/**
 * A union whose branches fix their discriminator with an `enum` (one branch can be
 * `kind: "browser" | "notebook" | "custom"`) is not detected as tagged by typify, which only
 * reads a single `const`; serde then tries variants by shape and drops the fields of the right
 * one. Expand such a branch into one branch per value, each with a `const`.
 */
function splitEnumTags(document: unknown): void {
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    for (const combinator of ["oneOf", "anyOf"]) {
      const branches = record[combinator];
      if (!Array.isArray(branches)) continue;
      // A branch that is a reference to a tagged union hides its tags from typify, which then
      // treats the whole union as untagged. Splice such a branch's options in.
      const resolved = resolveTaggedBranches(document, branches);
      const candidates = discriminatorKeys(resolved);
      const key = candidates[0];
      if (key !== undefined) {
        const expanded: unknown[] = [];
        for (const branch of resolved) {
          const branchRecord = branch as Record<string, unknown> | null;
          const properties =
            branchRecord !== null && typeof branchRecord === "object"
              ? (branchRecord.properties as Record<string, unknown> | undefined)
              : undefined;
          const field =
            properties !== undefined
              ? (properties[key] as Record<string, unknown> | undefined)
              : undefined;
          const values = field?.enum;
          if (Array.isArray(values) && values.every((value) => typeof value === "string")) {
            for (const value of values) {
              const copy = JSON.parse(JSON.stringify(branchRecord)) as Record<string, unknown>;
              const copyProperties = copy.properties as Record<string, unknown>;
              copyProperties[key] = { type: "string", const: value };
              delete copy.title;
              expanded.push(copy);
            }
          } else {
            expanded.push(branch);
          }
        }
        record[combinator] = expanded;
        for (const branch of expanded) walk(branch);
        continue;
      }
      for (const branch of resolved) walk(branch);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(document);
}

/**
 * A union's branches with `$ref`s resolved and nested unions spliced in, but only when the
 * result has a discriminator every branch fixes: the nested union is part of the same tagged
 * union (`ThreadStatus` is a union of a status union and the unknown-status object).
 */
function resolveTaggedBranches(document: unknown, branches: unknown[]): unknown[] {
  const defs = (document as Record<string, unknown>).$defs;
  const resolve = (ref: string): unknown => {
    if (defs === null || typeof defs !== "object") return undefined;
    const name = ref.replace(/^#\/\$defs\//, "");
    return (defs as Record<string, unknown>)[name];
  };
  const resolveRef = (branch: unknown): unknown => {
    const record = branch as Record<string, unknown> | null;
    if (record === null || typeof record !== "object" || typeof record.$ref !== "string")
      return branch;
    const target = resolve(record.$ref);
    return target === undefined ? branch : target;
  };
  const resolved = branches.map(resolveRef);
  const flatten = (branch: unknown): unknown[] => {
    const record = branch as Record<string, unknown> | null;
    if (record === null || typeof record !== "object") return [branch];
    const nested = record.oneOf ?? record.anyOf;
    if (!Array.isArray(nested)) return [branch];
    return nested.flatMap((option) => flatten(resolveRef(option)));
  };
  const flattened = resolved.flatMap(flatten);
  const everyObject = flattened.every((branch) => {
    const record = branch as Record<string, unknown> | null;
    return record !== null && typeof record === "object" && !Array.isArray(branch);
  });
  if (everyObject && discriminatorKeys(flattened).length > 0) return flattened;
  return resolved;
}

/** Keys every branch fixes with a `const` or a string `enum`, sorted as typify sorts them. */
function discriminatorKeys(branches: unknown[]): string[] {
  let common: Set<string> | undefined;
  for (const branch of branches) {
    const record = branch as Record<string, unknown> | null;
    if (record === null || typeof record !== "object") return [];
    const properties = record.properties as Record<string, unknown> | undefined;
    const required = record.required;
    if (properties === undefined || !Array.isArray(required)) return [];
    const fixed = new Set(
      Object.entries(properties)
        .filter(([key, fieldSchema]) => {
          if (!required.includes(key)) return false;
          if (fieldSchema === null || typeof fieldSchema !== "object") return false;
          const field = fieldSchema as Record<string, unknown>;
          if (typeof field.const === "string") return true;
          const values = field.enum;
          return Array.isArray(values) && values.every((value) => typeof value === "string");
        })
        .map(([key]) => key),
    );
    common = common === undefined ? fixed : new Set([...common].filter((key) => fixed.has(key)));
  }
  return [...(common ?? [])].toSorted();
}

/** Merge a union whose every branch is a string enum or const into one string enum. */
function mergePrimitiveUnions(document: unknown): void {
  const defs = (document as Record<string, unknown>).$defs;
  const resolve = (node: unknown): unknown => {
    let current = node;
    for (let hops = 0; hops < 32; hops += 1) {
      if (current === null || typeof current !== "object") return current;
      const record = current as Record<string, unknown>;
      const ref = record.$ref;
      if (typeof ref !== "string") return current;
      const name = ref.replace(/^#\/\$defs\//, "");
      if (defs === null || typeof defs !== "object") return current;
      const target = (defs as Record<string, unknown>)[name];
      const siblings = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
      current =
        target !== null && typeof target === "object" && Object.keys(siblings).length > 0
          ? { ...(target as Record<string, unknown>), ...siblings }
          : target;
    }
    return current;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const combinator of ["oneOf", "anyOf"]) {
      const branches = record[combinator];
      if (!Array.isArray(branches)) continue;
      const values: string[] = [];
      const types = new Set<string>();
      let everyEnum = true;
      for (const branch of branches) {
        const resolved = resolve(branch) as Record<string, unknown> | null;
        if (resolved === null || typeof resolved !== "object") {
          types.clear();
          break;
        }
        if (typeof resolved.type !== "string") {
          // A `.transform()` branch: its output is a primitive of the other branches' type;
          // the shape table states the fallback exactly, and the typed decode is permissive.
          if (resolved["x-ace-json-input"] !== undefined) {
            everyEnum = false;
            continue;
          }
          types.clear();
          break;
        }
        types.add(resolved.type);
        if (resolved.type === "string" && Array.isArray(resolved.enum)) {
          values.push(...(resolved.enum as string[]));
        } else if (resolved.type === "string" && typeof resolved.const === "string") {
          values.push(resolved.const);
        } else {
          everyEnum = false;
        }
      }
      const primitive =
        types.size === 1 &&
        ["string", "number", "integer", "boolean"].includes([...types][0] ?? "");
      if (primitive) {
        const type = [...types][0];
        const merged: Record<string, unknown> =
          everyEnum && values.length > 0 ? { type, enum: [...new Set(values)] } : { type };
        if (typeof record.title === "string") merged.title = record.title;
        if (typeof record.description === "string") merged.description = record.description;
        for (const key of Object.keys(record)) delete record[key];
        Object.assign(record, merged);
        continue;
      }
      for (const branch of branches) walk(branch);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(document);
}

/** Give every inline object and enum a title from its path, so typify names each one uniquely. */
function titleInlineSchemas(document: unknown): void {
  const properties = (document as Record<string, unknown>).properties;
  if (properties !== null && typeof properties === "object")
    for (const [name, child] of Object.entries(properties as Record<string, unknown>))
      walkInline(child, pascal(name));
  const defs = (document as Record<string, unknown>).$defs;
  if (defs !== null && typeof defs === "object")
    for (const [key, child] of Object.entries(defs as Record<string, unknown>)) {
      const title = (child as Record<string, unknown> | null)?.title;
      walkInline(child, typeof title === "string" ? pascal(title) : pascal(key));
    }
}

/** One node of [`titleInlineSchemas`]. */
function walkInline(node: unknown, parent: string): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") return;
  const kind = record.type;
  const named = kind === "object" || Array.isArray(record.enum);
  if (named && typeof record.title !== "string" && parent !== "") record.title = parent;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      if (child === null || typeof child !== "object" || Array.isArray(child)) continue;
      const childRecord = child as Record<string, unknown>;
      if (typeof childRecord.$ref === "string") continue;
      walkInline(child, `${parent}${pascal(key)}`);
    }
  }
  const items = record.items;
  if (items !== undefined) walkInline(items, `${parent}Item`);
  const additional = record.additionalProperties;
  if (additional !== null && typeof additional === "object")
    walkInline(additional, `${parent}Value`);
  for (const combinator of ["anyOf", "oneOf"]) {
    const branches = record[combinator];
    if (!Array.isArray(branches)) continue;
    for (const [index, branch] of branches.entries()) {
      if (branch === null || typeof branch !== "object" || Array.isArray(branch)) continue;
      const branchRecord = branch as Record<string, unknown>;
      if (typeof branchRecord.$ref === "string") continue;
      const tag = constOf(branch);
      walkInline(branch, `${parent}${tag === null ? `Branch${index}` : pascal(tag)}`);
    }
  }
}

/** The string a branch's own `type` field is fixed to, when it is inline. */
function constOf(branch: Record<string, unknown>): string | null {
  const properties = branch.properties;
  if (properties === null || typeof properties !== "object") return null;
  const value = (
    (properties as Record<string, unknown>).type as Record<string, unknown> | undefined
  )?.const;
  return typeof value === "string" ? value : null;
}

/** `ace-protocol/src/wire.rs`: the per-message dispatch the transport and the daemon use. */
function wireSource(messages: { client: WireMessage[]; server: WireMessage[] }): string {
  const names = (list: WireMessage[]): void => {
    const seen = new Map<string, string>();
    const used = new Set<string>();
    for (const message of list) {
      const previous = seen.get(message.type);
      if (previous !== undefined)
        throw new Error(`${message.type} is defined twice (${previous}, ${message.name})`);
      seen.set(message.type, message.name);
      if (used.has(message.name)) throw new Error(`two message types are named ${message.name}`);
      used.add(message.name);
    }
  };
  names(messages.client);
  names(messages.server);
  const variants = (list: WireMessage[]) =>
    list.map((message) => `    ${message.name}(${message.name}),`).join("\n");
  const typeArms = (list: WireMessage[], union: string) =>
    list
      .map(
        (message) => `            ${union}::${message.name}(_) => ${JSON.stringify(message.type)},`,
      )
      .join("\n");
  const decodeArms = (list: WireMessage[], union: string, direction: string) =>
    list
      .map(
        (message) =>
          `        ${JSON.stringify(message.type)} => Some(decode_${direction}_${message.name.toLowerCase()}(value)),`,
      )
      .join("\n");
  const decodeFns = (list: WireMessage[], union: string, direction: string) =>
    list
      .map(
        (message) => `/// One ${direction} body, decoded as its own type.
fn decode_${direction}_${message.name.toLowerCase()}(
    value: &Value,
) -> Result<${union}, String> {
    ace_json::from_value(value)
        .map(${union}::${message.name})
        .map_err(|error| error.to_string())
}`,
      )
      .join("\n\n");
  const encodeArms = (list: WireMessage[], union: string, direction: string) =>
    list
      .map(
        (message) =>
          `        ${union}::${message.name}(body) => encode_${direction}_${message.name.toLowerCase()}(body),`,
      )
      .join("\n");
  const encodeFns = (list: WireMessage[], direction: string) =>
    list
      .map(
        (message) => `/// One ${direction} body, written through \`ace-json\`.
fn encode_${direction}_${message.name.toLowerCase()}(body: &${message.name}) -> Result<String, String> {
    ace_json::ser::to_string(body).map_err(|error| error.to_string())
}`,
      )
      .join("\n\n");
  const enumOf = (
    direction: "client" | "server",
    union: string,
  ) => `/// One ${direction} message body, as its own generated type.
#[derive(Clone, Debug)]
pub enum ${union} {
${variants(messages[direction])}
}

impl ${union} {
    /// The wire \`type\` this body is.
    pub fn type_(&self) -> &'static str {
        match self {
${typeArms(messages[direction], union)}
        }
    }
}`;
  return `// SPDX-License-Identifier: Apache-2.0
// Generated by scripts/generate-rust-protocol.ts -- do not edit.
//! The wire's dispatch (ADR 0226 §3): the envelope names a \`type\`, and the body decodes with
//! that message's own generated type. One variant per type, in the schema's own order.
//!
//! Each body has its own tiny decode and encode function so the dispatcher's frame stays small:
//! one match with 180 inlined decodes reserves a stack slot per arm in debug builds.
#![allow(clippy::large_enum_variant)]
#![allow(clippy::unwrap_used)]

use ace_json::Value;

use crate::generated::*;

${enumOf("client", "ClientBody")}

/// Decode a client body as its \`type\` names it; \`None\` when no message has that type.
pub fn decode_client(type_: &str, value: &Value) -> Option<Result<ClientBody, String>> {
    match type_ {
${decodeArms(messages.client, "ClientBody", "client")}
        _ => None,
    }
}

${decodeFns(messages.client, "ClientBody", "client")}

/// \`body\` as the bytes a client parses, through \`ace-json\`.
pub fn encode_client(body: &ClientBody) -> Result<String, String> {
    match body {
${encodeArms(messages.client, "ClientBody", "client")}
    }
}

${encodeFns(messages.client, "client")}

${enumOf("server", "ServerBody")}

/// Decode a server body as its \`type\` names it; \`None\` when no message has that type.
pub fn decode_server(type_: &str, value: &Value) -> Option<Result<ServerBody, String>> {
    match type_ {
${decodeArms(messages.server, "ServerBody", "server")}
        _ => None,
    }
}

${decodeFns(messages.server, "ServerBody", "server")}

/// \`body\` as the bytes a client parses, through \`ace-json\`.
pub fn encode_server(body: &ServerBody) -> Result<String, String> {
    match body {
${encodeArms(messages.server, "ServerBody", "server")}
    }
}

${encodeFns(messages.server, "server")}
`;
}

function runMain(): void {
  const scratchDir = mkdtempSync(join(tmpdir(), "ace-protocol-"));
  try {
    generate(scratchDir);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function channel(): string {
  const toolchain = readFileSync(join(root, "native", "daemon", "rust-toolchain.toml"), "utf8");
  const found = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  if (found === undefined) throw new Error("native/daemon/rust-toolchain.toml names no channel");
  return found;
}

/** `cargo` on the workspace's pinned toolchain, like `check:daemon-native` runs it. */
let hasRustup = true;
try {
  execFileSync("rustup", ["--version"], { stdio: "ignore" });
} catch {
  hasRustup = false;
}

function cargo(args: string[], options: object): string {
  const cwd = join(root, "native", "daemon");
  if (hasRustup)
    return execFileSync("rustup", ["run", channel(), "cargo", ...args], {
      cwd,
      ...options,
    }) as string;
  return execFileSync("cargo", args, { cwd, ...options }) as string;
}

function runRustfmt(path: string): void {
  if (hasRustup) execFileSync("rustup", ["run", channel(), "rustfmt", "--edition", "2024", path]);
  else execFileSync("rustfmt", ["--edition", "2024", path]);
}

function generate(scratchDir: string): void {
  if (process.env.ACE_PROTOCOL_DUMP !== undefined)
    writeFileSync(process.env.ACE_PROTOCOL_DUMP, JSON.stringify(schema));
  const schemaPath = join(scratchDir, "protocol.json");
  writeFileSync(schemaPath, `${JSON.stringify(schema)}\n`);
  const raw = join(scratchDir, "generated.raw.rs");
  const typed = cargo(["run", "--quiet", "-p", "ace-protocol-gen", "--", schemaPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = typed;
  // The file is committed and never hand-edited; the header marks it as
  // generated and silences lints inherent to typify's output style: casing
  // from wire values (`-1`, `+1`), infallible conversions it emits as
  // `TryFrom`, newtypes it could derive, and untagged unions whose variants
  // differ in size.
  const header = `// SPDX-License-Identifier: Apache-2.0
// Generated by scripts/generate-rust-protocol.ts -- do not edit.
#![allow(non_camel_case_types)]
#![allow(clippy::derivable_impls)]
#![allow(clippy::infallible_try_from)]
#![allow(clippy::large_enum_variant)]
#![allow(clippy::unwrap_used)]
`;
  // `typify` spells an unconstrained value as `serde_json::Value`, whose map is sorted by key.
  // A wire value keeps the key order it was given (`z.unknown()` payloads go to clients
  // verbatim), so the same tree is `ace_json::Value`, which parses and writes in JS order.
  writeFileSync(raw, `${header}${out}`);
  // Format with the pinned toolchain's rustfmt, as `cargo fmt` would; replace, then format
  // again so the replacements' own line lengths are the formatter's decision.
  runRustfmt(raw);
  const replaced = readFileSync(raw, "utf8")
    .replaceAll("::serde_json::Map<::std::string::String, ::serde_json::Value>", "::ace_json::Map")
    .replaceAll("::serde_json::Map::is_empty", "::ace_json::Map::is_empty")
    .replaceAll("::serde_json::Value", "::ace_json::Value")
    .replaceAll("::serde_json::Map", "::ace_json::Map")
    // typify's `Default` for an unconstrained object's `{}`: `ace_json::Map`'s item type is
    // fixed, so the empty literal can't infer it.
    .replaceAll("[].into_iter().collect()", "Default::default()");
  writeFileSync(raw, replaced);
  runRustfmt(raw);
  const generated = join(root, "native", "daemon", "crates", "ace-protocol", "src", "generated.rs");
  const formatted = readFileSync(raw, "utf8");
  if (process.argv.includes("--check")) {
    const committed = readFileSync(generated, "utf8");
    if (formatted !== committed)
      throw new Error(`${generated} is stale; run bun scripts/generate-rust-protocol.ts`);
    console.log("ace-protocol/src/generated.rs is fresh");
  } else {
    writeFileSync(generated, formatted);
    console.log(`wrote ${generated}`);
  }
  // The shape table for the column encoders (porting guide 5.3b): the same schemas, walked by
  // `rust-protocol-shapes.ts` instead of through JSON Schema, because `typify` can't describe
  // Zod's stripping, defaults and key order.
  const shapesDir = join(root, "native", "daemon", "crates", "ace-protocol", "src", "shapes");
  const shapeFiles = shapesSource(
    {
      THREAD_CLIENT_COLUMN: ThreadClientFields.omit({ details: true }),
      THREAD_DETAILS: ThreadDetails,
      THREAD_PROVIDER_METADATA: ThreadProviderMetadata,
      KNOWN_THREAD_STATUS: KnownThreadStatus,
      // The wire's roots (ADR 0226 §3): what Zod's parse keeps of every client and server
      // message, in schema order, so a Rust decoder strips, defaults and orders like Zod.
      CLIENT_MESSAGE: ClientMessage,
      BROWSER_BACKEND_CLIENT_MESSAGE: BrowserBackendClientMessage,
      USER_BROWSER_EXTENSION_MESSAGE: UserBrowserExtensionMessage,
      SERVER_MESSAGE: ServerMessage,
      CORE_CLIENT_MESSAGE: CoreClientMessage,
      CORE_SERVER_MESSAGE: CoreServerMessage,
    },
    new Map([[ThreadStatus, "crate::custom::THREAD_STATUS"]]),
  );
  // The wire's dispatch: one variant per message type, decoded by the envelope's `type`.
  const wireTarget = join(root, "native", "daemon", "crates", "ace-protocol", "src", "wire.rs");
  const wirePath = join(scratchDir, "wire.rs");
  writeFileSync(wirePath, wireSource(wireMessages));
  runRustfmt(wirePath);
  const wire = readFileSync(wirePath, "utf8");
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(wireTarget, "utf8");
    } catch {
      // Missing files are stale too, and the message below names them.
    }
    if (wire !== committed)
      throw new Error(`${wireTarget} is stale; run bun scripts/generate-rust-protocol.ts`);
    console.log("ace-protocol/src/wire.rs is fresh");
  } else {
    writeFileSync(wireTarget, wire);
    console.log(`wrote ${wireTarget}`);
  }
  // Files a previous generation wrote for roots that are gone would otherwise linger. Only
  // touch the directory when writing; `--check` compares what the table names.
  if (!process.argv.includes("--check")) {
    const written = new Set(shapeFiles.keys());
    for (const name of readdirSync(shapesDir)) {
      if (name.endsWith(".rs") && !written.has(name)) rmSync(join(shapesDir, name));
    }
  }
  // Write every part first, so rustfmt can resolve `mod` from `mod.rs` in the scratch dir.
  const rawPaths = [...shapeFiles].map(([name, source]) => {
    const path = join(scratchDir, name);
    writeFileSync(path, source);
    return { name, path, target: join(shapesDir, name) };
  });
  for (const { name, path: rawPath, target } of rawPaths) {
    runRustfmt(rawPath);
    const shaped = readFileSync(rawPath, "utf8");
    if (process.argv.includes("--check")) {
      let committed = "";
      try {
        committed = readFileSync(target, "utf8");
      } catch {
        // Missing files are stale too, and the message below names them.
      }
      if (shaped !== committed)
        throw new Error(`${target} is stale; run bun scripts/generate-rust-protocol.ts`);
      console.log(`ace-protocol/src/shapes/${name} is fresh`);
    } else {
      mkdirSync(shapesDir, { recursive: true });
      writeFileSync(target, shaped);
      console.log(`wrote ${target}`);
    }
  }
}

runMain();
