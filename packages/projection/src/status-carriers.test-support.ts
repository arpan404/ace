import { SearchHit, ServerMessage, ThreadStatus } from "@ace/protocol";
import type { z } from "zod";

/*
 * Every place in the server wire schema that holds a thread status, found by walking the
 * schema itself, so a message type that starts carrying one is covered without a list to keep.
 * A path reads `type: .field[].field{}(key=value).status`: the message type, then `[]` an
 * array, `{}` a record, `(key=value)` the union member whose `key` is `value`.
 */

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  options?: z.ZodType[];
  element?: z.ZodType;
  valueType?: z.ZodType;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  getter?: () => z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
  items?: z.ZodType[];
};
const defOf = (schema: unknown): Def | undefined =>
  typeof schema === "object" && schema !== null ? (schema as { def?: Def }).def : undefined;
const literal = (schema: unknown): string | undefined => {
  const values = (defOf(schema) as { values?: unknown[] } | undefined)?.values;
  return typeof values?.[0] === "string" ? values[0] : undefined;
};

/** A status leaf: a whole `ThreadStatus`, or a search hit's bare state word. */
export type Leaf = "status" | "state-word";
const leaves = new Map<unknown, Leaf>([
  [ThreadStatus, "status"],
  [SearchHit.shape.status, "state-word"],
]);

function walk(schema: unknown, path: string, stack: Set<unknown>, out: Map<string, Leaf>) {
  const leaf = leaves.get(schema);
  if (leaf) {
    out.set(path, leaf);
    return;
  }
  const def = defOf(schema);
  if (!def || stack.has(schema)) return;
  const inner = new Set(stack).add(schema);
  switch (def.type) {
    case "object":
      for (const [key, value] of Object.entries(def.shape ?? {}))
        walk(value, `${path}.${key}`, inner, out);
      return;
    case "union":
      for (const option of def.options ?? []) {
        const shape = defOf(option)?.shape ?? {};
        const key = ["type", "kind", "state"].find((name) => literal(shape[name]) !== undefined);
        walk(option, key ? `${path}(${key}=${literal(shape[key])})` : path, inner, out);
      }
      return;
    case "array": {
      // `[key, value]` pairs are how a record of opaque ids is read (`records` in the schema).
      const pair = defOf(def.element);
      if (pair?.type === "tuple") return walk(pair.items?.[1], `${path}{}`, inner, out);
      return walk(def.element, `${path}[]`, inner, out);
    }
    case "record":
      return walk(def.valueType, `${path}{}`, inner, out);
    case "pipe":
      walk(def.in, path, inner, out);
      return walk(def.out, path, inner, out);
    case "lazy":
      return walk(def.getter?.(), path, inner, out);
    case "intersection":
      walk(def.left, path, inner, out);
      return walk(def.right, path, inner, out);
    default:
      if (def.innerType) walk(def.innerType, path, inner, out);
  }
}

/** Every thread-status path in `ServerMessage`, rooted at each message's `type`. */
export function statusCarriers(): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  for (const option of (defOf(ServerMessage)?.options ?? []) as unknown[]) {
    const type = literal(defOf(option)?.shape?.type);
    if (type) walk(option, `${type}:`, new Set(), out);
  }
  return out;
}

/**
 * A message holding `value` at `path`: arrays of one, records of one entry keyed `k`, union
 * members chosen by their key, each object along the way starting from `fill[field]` (the
 * siblings the schema guarantees). Not a valid message, only the shape a status rewrite reads.
 */
export function messageAt(
  path: string,
  value: unknown,
  fill: Record<string, () => Record<string, unknown>> = {},
): Record<string, unknown> {
  const colon = path.indexOf(":");
  const steps = path.slice(colon + 1).match(/\([a-z]+=[^)]+\)|\.[A-Za-z]+|\[\]|\{\}/g) ?? [];
  const root: Record<string, unknown> = { type: path.slice(0, colon) };
  let at: Record<string, unknown> = root;
  let pending: string | undefined;
  const filled = (field: string) => fill[field]?.() ?? {};
  const descend = () => {
    if (pending === undefined) throw new Error(`No field before a container in ${path}`);
    const next = filled(pending);
    at[pending] = next;
    at = next;
    pending = undefined;
  };
  for (const step of steps) {
    if (step.startsWith("(")) {
      const [key, variant] = step.slice(1, -1).split("=") as [string, string];
      if (pending !== undefined) descend();
      at[key] = variant;
    } else if (step === "[]" || step === "{}") {
      const holder = filled(pending ?? "");
      const container = step === "[]" ? [holder] : { k: holder };
      if (pending === undefined) throw new Error(`No field before a container in ${path}`);
      at[pending] = container;
      at = holder;
      pending = undefined;
    } else {
      if (pending !== undefined) descend();
      pending = step.slice(1);
    }
  }
  if (pending === undefined) throw new Error(`No leaf field in ${path}`);
  at[pending] = value;
  return root;
}
