import { z } from "zod";

export type JsonSchema = z.core.JSONSchema.JSONSchema;
export interface SchemaEntry {
  name: string;
  schema: z.ZodType;
  io?: "input" | "output";
}
export interface ToolEntry {
  name: string;
  description: string;
  capability: string | null;
  timeoutMs: number;
  input: string;
  output: string;
}
export interface Snapshot {
  protocolVersion: number;
  schemas: Record<string, JsonSchema>;
}
export const schemaId = (name: string, version = 1): string =>
  `https://ace.local/protocol/v${version}/${name}.json`;
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
export function schemaNode(value: unknown): JsonSchema {
  return value === false ? { not: {} } : object(value);
}
export function nodes(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.map(schemaNode) : [];
}
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
export function canonical(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_, item: unknown) => {
        if (!isObject(item)) return item;
        return Object.fromEntries(
          Object.keys(item)
            .toSorted()
            .map((key) => [key, item[key]]),
        );
      },
      2,
    ) + "\n"
  );
}
export function resolve(schema: JsonSchema, schemas: Record<string, JsonSchema>): JsonSchema {
  let current = schema;
  const seen = new Set<string>();
  while (current.$ref) {
    if (seen.has(current.$ref)) throw new Error(`Circular reference ${current.$ref}`);
    seen.add(current.$ref);
    const [id, fragment] = current.$ref.split("#");
    let target: unknown = Object.values(schemas).find((entry) => entry.$id === id);
    if (!target) throw new Error(`Unknown reference ${current.$ref}`);
    for (const key of (fragment ?? "").split("/").slice(1))
      target = object(target)[decodeURIComponent(key).replace(/~1/g, "/").replace(/~0/g, "~")];
    if (!isObject(target)) throw new Error(`Invalid reference ${current.$ref}`);
    const { $ref: _, ...siblings } = current;
    const validationKeys = Object.keys(siblings).filter(
      (key) =>
        ![
          "$id",
          "$schema",
          "$defs",
          "title",
          "description",
          "examples",
          "$comment",
          "deprecated",
        ].includes(key),
    );
    if (validationKeys.length) return { allOf: [target, siblings] };
    current = { ...target, ...siblings };
  }
  return current;
}
