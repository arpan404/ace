/* oxlint-disable eslint/no-underscore-dangle -- Zod exposes typed checks through its _zod API. */
import { z } from "zod";
import { schemaId, type SchemaEntry, type Snapshot } from "./model.ts";

/** Conversion guards cover checks that Zod otherwise omits in JSON Schema. */
function guard(schema: z.core.$ZodType, path: (string | number)[]): void {
  const def = schema._zod.def;
  if (
    def.type === "pipe" ||
    def.type === "transform" ||
    def.type === "file" ||
    def.type === "catch" ||
    ("coerce" in def && def.coerce)
  )
    throw new Error(`Unsupported ${def.type} at ${path.join(".") || "root"}`);
  if (def.checks?.some((check) => check._zod.def.check === "overwrite"))
    throw new Error(`Unsupported overwrite at ${path.join(".") || "root"}`);
  const custom = def.checks?.some((check) => check._zod.def.check === "custom");
  if (custom && typeof z.globalRegistry.get(schema)?.["x-ace-constraint"] !== "string")
    throw new Error(
      `Unsupported custom refinement at ${path.join(".") || "root"}; add a source-owned x-ace-constraint for semantic rules`,
    );
}

function preflight(root: z.ZodType): void {
  const seen = new Set<z.ZodType>();
  function visit(value: unknown, path: (string | number)[]): void {
    if (path.length > 64) throw new Error("Schema depth exceeds 64");
    if (value instanceof z.ZodType) {
      if (seen.has(value)) return;
      seen.add(value);
      guard(value, path);
      if (value instanceof z.ZodLazy) visit(value.unwrap(), [...path, "lazy"]);
      for (const [key, child] of Object.entries(value._zod.def))
        if (key !== "checks") visit(child, [...path, key]);
    } else if (Array.isArray(value))
      value.forEach((child, index) => visit(child, [...path, index]));
    else if (typeof value === "object" && value !== null)
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  }
  visit(root, []);
}

function protocolVersion(entries: SchemaEntry[]): number {
  const versions: number[] = [];
  for (const [name, tag] of [
    ["ClientMessage", "hello"],
    ["ServerMessage", "welcome"],
  ]) {
    const entry = entries.find((item) => item.name === name);
    if (!entry) continue;
    if (!(entry.schema instanceof z.ZodUnion))
      throw new Error(`Schema ${name}: expected a handshake union`);
    const handshake = entry.schema.options.find(
      (option) =>
        option instanceof z.ZodObject &&
        option.shape.type instanceof z.ZodLiteral &&
        option.shape.type.value === tag,
    );
    if (
      !(handshake instanceof z.ZodObject) ||
      !(handshake.shape.protocolVersion instanceof z.ZodLiteral) ||
      typeof handshake.shape.protocolVersion.value !== "number"
    )
      throw new Error(`Schema ${name}: missing numeric protocolVersion`);
    versions.push(handshake.shape.protocolVersion.value);
  }
  const version = versions[0] ?? 1;
  if (!Number.isSafeInteger(version) || version < 1 || versions.some((v) => v !== version))
    throw new Error("Schema ClientMessage/ServerMessage: inconsistent protocol versions");
  return version;
}

export function convertSchemas(entries: SchemaEntry[]): Snapshot {
  if (entries.length > 1024) throw new Error("Schema count exceeds 1024");
  const names = new Set<string>();
  const schemas: Snapshot["schemas"] = {};
  const version = protocolVersion(entries);
  for (const entry of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(entry.name) || names.has(entry.name))
      throw new Error(`Invalid or duplicate schema name: ${entry.name}`);
    names.add(entry.name);
    try {
      preflight(entry.schema);
    } catch (error) {
      throw new Error(
        `Schema ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  // Separate registries preserve input defaults versus output requiredness.
  for (const io of ["input", "output"] as const) {
    const group = entries
      .filter((entry) => (entry.io ?? "input") === io)
      .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const registry = z.registry<{ id: string }>();
    for (const entry of group)
      registry.add(registry.has(entry.schema) ? entry.schema.clone() : entry.schema, {
        id: entry.name,
      });
    try {
      const result = z.toJSONSchema(registry, {
        io,
        target: "draft-2020-12",
        unrepresentable: "throw",
        reused: "inline",
        cycles: "throw",
        uri: (id) => schemaId(id, version),
      });
      for (const entry of group) {
        const schema = result.schemas[entry.name];
        if (!schema) throw new Error(`Missing conversion for ${entry.name}`);
        schemas[entry.name] = schema;
      }
    } catch (error) {
      // Diagnose through individual conversion to name the owning export.
      for (const entry of group) {
        try {
          z.toJSONSchema(entry.schema, { io, unrepresentable: "throw", cycles: "throw" });
        } catch (cause) {
          throw new Error(
            `Schema ${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
      throw error;
    }
  }
  return { protocolVersion: version, schemas };
}
