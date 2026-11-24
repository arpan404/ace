// SPDX-License-Identifier: Apache-2.0
/*
 * The machinery behind `column-vectors.ts`: the sampled shapes, JSON-text paths, the bind
 * oracle and one case's record. The cases themselves live in `column-vector-shapes.ts` and
 * `column-vector-writes.ts`.
 */

// oxlint-disable-next-line no-restricted-imports -- the vectors' own in-memory binder oracle, never events.sqlite (ADR 0222).
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ThreadClientFields,
  ThreadDetails,
  ThreadProviderMetadata,
  type EventPayload,
} from "@ace/protocol";
import { fieldSamples } from "../apps/daemon/src/thread-column-samples.ts";
import {
  coldRowValues,
  threadColumnChanges,
  threadColumnNames,
  threadColumnValue,
  writtenColumns,
  type ThreadColumn,
  type ThreadColumnChanges,
} from "../apps/daemon/src/thread-columns.ts";

export type ValueRecord =
  | ["text", string]
  | ["number", string]
  | ["null"]
  | ["rejected"]
  | ["unstorable"];
export type Changes = {
  row: [string, ValueRecord][];
  hot: [string, ValueRecord][];
  cold: [string, ValueRecord][];
  parts: string[];
  coldRow: [ValueRecord, ValueRecord] | null;
};
export type Case = {
  name: string;
  previous: string | null;
  next: string;
  wanted: string[];
  values: [string, ValueRecord][];
  changes: Changes | null;
};
export type Family = "client" | "details" | "acp";
export type Path = (string | number)[];
export type Parts = Record<Family, Record<string, unknown>>;

export const roots = {
  client: ThreadClientFields.omit({ details: true }),
  details: ThreadDetails,
  acp: ThreadProviderMetadata,
};

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  entries?: Record<string, string>;
  values?: unknown[];
};

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { def: Def }).def;
}

export function clone<T>(value: T): T {
  return structuredClone(value) as T;
}

export function pristine(): Parts {
  return {
    client: clone(fieldSamples.client) as Record<string, unknown>,
    details: clone(fieldSamples.details) as Record<string, unknown>,
    acp: clone(fieldSamples.acp) as Record<string, unknown>,
  };
}

export function baseThread(): Record<string, unknown> {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    title: "Task",
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A thread as JSON: the base fields plus the three sampled shapes. */
export function thread(parts: Parts): Record<string, unknown> {
  return {
    ...baseThread(),
    ...clone(parts.client),
    ...clone(parts.acp),
    details: clone(parts.details),
  };
}

function lookup(node: unknown, key: string | number): unknown {
  if (Array.isArray(node)) return typeof key === "number" ? node[key] : undefined;
  if (typeof node === "object" && node !== null)
    return (node as Record<string, unknown>)[String(key)];
  return undefined;
}

export function nodeAt(node: unknown, path: Path): unknown {
  let current = node;
  for (const key of path) current = lookup(current, key);
  return current;
}

function replace(node: unknown, key: string | number, value: unknown): void {
  if (Array.isArray(node)) {
    if (typeof key !== "number") throw new Error(`array key ${key}`);
    node[key] = value;
    return;
  }
  if (typeof node === "object" && node !== null) {
    (node as Record<string, unknown>)[String(key)] = value;
    return;
  }
  throw new Error(`cannot replace ${String(key)} on ${typeof node}`);
}

export function setPath(node: unknown, path: Path, value: unknown): void {
  const last = path.at(-1);
  if (last === undefined) throw new Error("empty path");
  replace(nodeAt(node, path.slice(0, -1)), last, value);
}

export function deletePath(node: unknown, path: Path): void {
  const last = path.at(-1);
  if (last === undefined) throw new Error("empty path");
  const holder = nodeAt(node, path.slice(0, -1));
  if (typeof holder === "object" && holder !== null)
    delete (holder as Record<string, unknown>)[String(last)];
}

/** An own `__proto__` key, which assignment would set the prototype instead. */
export function addUnknown(node: unknown): void {
  replace(node, "mystery", 1);
  replace(node, "0", "zero");
  if (typeof node !== "object" || node === null) throw new Error("unknown keys need an object");
  Object.defineProperty(node, "__proto__", {
    value: "pwned",
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function mutated(family: Family, path: Path, value: unknown): Parts {
  const parts = pristine();
  setPath(parts[family], path, value);
  return parts;
}

export function removed(family: Family, path: Path): Parts {
  const parts = pristine();
  deletePath(parts[family], path);
  return parts;
}

export const dotted = (path: Path) => path.join(".");

export const wantedAll = writtenColumns({
  type: "thread.updated",
  acp: {},
} as unknown as EventPayload);

const db = new DatabaseSync(":memory:");
function binds(value: unknown): boolean {
  try {
    db.prepare("SELECT ?").get(value as never);
    return true;
  } catch {
    return false;
  }
}

function primitive(name: string, column: string, value: unknown): ValueRecord {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    if (!binds(value))
      throw new Error(`${name}: ${column}: the binder refuses a value the table stores`);
    if (typeof value === "string") return ["text", value];
    if (typeof value === "number") return ["number", String(value)];
    return ["null"];
  }
  if (binds(value))
    throw new Error(`${name}: ${column}: the binder accepts a ${typeof value} the table refuses`);
  return ["unstorable"];
}

function valueRecord(name: string, column: ThreadColumn, next: unknown): ValueRecord {
  let value: unknown;
  try {
    value = threadColumnValue(next as never, column);
  } catch {
    return ["rejected"];
  }
  return primitive(name, column, value);
}

function recordChanges(name: string, previous: unknown, found: ThreadColumnChanges): Changes {
  const list = (entries: [ThreadColumn, unknown][]) =>
    entries.map(([column, value]): [string, ValueRecord] => [
      column,
      primitive(name, column, value),
    ]);
  const coldRow = found.cold.length
    ? (coldRowValues(previous as never, found).map((value, index) =>
        primitive(name, index === 0 ? "details" : "capabilities", value),
      ) as [ValueRecord, ValueRecord])
    : null;
  return {
    row: list(Object.entries(found.row) as unknown as [ThreadColumn, unknown][]),
    hot: list(found.hot as [ThreadColumn, unknown][]),
    cold: list(found.cold as [ThreadColumn, unknown][]),
    parts: [...found.parts],
    coldRow,
  };
}

function unstorableChange(changes: Changes): boolean {
  const lists = [changes.row, changes.hot, changes.cold];
  return (
    lists.some((list) => list.some(([, value]) => value[0] === "unstorable")) ||
    (changes.coldRow?.some((value) => value[0] === "unstorable") ?? false)
  );
}

/**
 * One case from its JSON texts, or from values that are stringified here. A change whose value
 * SQLite won't bind is exactly what Rust's `ColumnError::NotStorable` reports as an error, so
 * its change set is not recorded and Rust only checks that the call returns without panicking.
 */
export function makeCase(
  name: string,
  previous: unknown,
  next: unknown,
  wanted: readonly ThreadColumn[],
  texts: { previous?: string; next?: string } = {},
): Case {
  const nextText = texts.next ?? JSON.stringify(next);
  const previousText =
    previous === null && texts.previous === undefined
      ? null
      : (texts.previous ?? JSON.stringify(previous));
  const previousValue = previousText === null ? undefined : JSON.parse(previousText);
  const nextValue = JSON.parse(nextText);
  const values = threadColumnNames.map((column): [string, ValueRecord] => [
    column,
    valueRecord(name, column, nextValue),
  ]);
  let changes: Changes | null = null;
  try {
    changes = recordChanges(
      name,
      previousValue,
      threadColumnChanges(previousValue, nextValue, wanted),
    );
  } catch {
    changes = null;
  }
  if (changes !== null && unstorableChange(changes)) changes = null;
  return { name, previous: previousText, next: nextText, wanted: [...wanted], values, changes };
}

/** Candidates for a second legal value; the caller checks the whole sample parses. */
export function candidates(schema: z.ZodType): unknown[] {
  const definition = defOf(schema);
  switch (definition.type) {
    case "optional":
    case "default":
    case "readonly": {
      const inner = definition.innerType;
      return inner === undefined ? [] : candidates(inner);
    }
    case "nullable": {
      const inner = definition.innerType;
      return inner === undefined ? [] : [null, ...candidates(inner)];
    }
    case "string":
      return ["x", "https://example.invalid/x", "0123456789abcdef0123456789abcdef01234567"];
    case "number":
      return [1, 0, 2];
    case "boolean":
      return [true, false];
    case "enum":
      return Object.keys(definition.entries ?? {});
    case "literal":
      return definition.values ?? [];
    case "array": {
      const element = definition.element;
      if (element === undefined) return [];
      const first = candidates(element)[0];
      return first === undefined ? [] : [[first]];
    }
    case "record":
      return [{}];
    case "object": {
      const value: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(definition.shape ?? {})) {
        const fieldType = defOf(field).type;
        if (fieldType === "optional" || fieldType === "default") continue;
        const first = candidates(field)[0];
        if (first !== undefined) value[key] = first;
      }
      return [value];
    }
    case "union": {
      const options = definition.options ?? [];
      if (definition.discriminator !== undefined)
        return options.map((option) => candidates(option)[0]);
      return options.flatMap((option) => candidates(option));
    }
    case "unknown":
      return [null];
    default:
      return [];
  }
}

export interface Field {
  path: Path;
  schema: z.ZodType;
  optional: boolean;
}

export function fieldsOf(schema: z.ZodType, value: unknown, path: Path, out: Field[]): void {
  const definition = defOf(schema);
  const current =
    definition.type === "optional" || definition.type === "default" ? definition.innerType : schema;
  if (current === undefined || defOf(current).type !== "object") return;
  for (const [key, field] of Object.entries(defOf(current).shape ?? {})) {
    const fieldPath = [...path, key];
    const fieldDef = defOf(field);
    const optional = fieldDef.type === "optional" || fieldDef.type === "default";
    const nested = optional ? fieldDef.innerType : field;
    out.push({ path: fieldPath, schema: field, optional });
    if (nested !== undefined && defOf(nested).type === "object" && lookup(value, key) !== undefined)
      fieldsOf(field, lookup(value, key), fieldPath, out);
  }
}
