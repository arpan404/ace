/* oxlint-disable eslint/no-underscore-dangle -- Zod exposes its typed schema definition. */
import { z } from "zod";
import type { SchemaEntry } from "./model.ts";

/** Source-owned structural schemas describe guarded decoders in JSON input mode. */
export function inputProjection(entries: SchemaEntry[]): SchemaEntry[] {
  const seen = new Map<z.ZodType, z.ZodType>();
  function visit(value: unknown): unknown {
    if (value instanceof z.ZodType) {
      const existing = seen.get(value);
      if (existing) return existing;
      const projection = value.meta()?.["x-ace-json-input"];
      let result: z.ZodType;
      if (projection !== undefined) {
        if (!(projection instanceof z.ZodType) || !value.meta()?.["x-ace-constraint"])
          throw new Error("Structural input projection requires a source schema and semantic rule");
        const projected = visit(projection);
        if (!(projected instanceof z.ZodType)) throw new Error("Invalid structural projection");
        result = projected.meta({ "x-ace-constraint": value.meta()?.["x-ace-constraint"] });
      } else {
        const def = { ...value._zod.def };
        result = value.clone(def);
        const metadata = value.meta();
        if (metadata) result = result.meta(metadata);
        seen.set(value, result);
        if (value instanceof z.ZodLazy) {
          const inner = visit(value.unwrap());
          Object.defineProperty(def, "getter", { value: () => inner, enumerable: true });
        }
        for (const [key, child] of Object.entries(def)) {
          if (key !== "checks")
            Object.defineProperty(def, key, { value: visit(child), enumerable: true });
        }
      }
      seen.set(value, result);
      return result;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    return value;
  }
  return entries.map((entry) => {
    if (entry.io === "output") return entry;
    const schema = visit(entry.schema);
    if (!(schema instanceof z.ZodType)) throw new Error("Invalid input schema");
    return { ...entry, schema };
  });
}
