import { z } from "zod";

export const Append = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1),
  text: z.string(),
  seed: z.record(z.string(), z.unknown()).optional(),
});
export type Append = z.infer<typeof Append>;
/** Persistence codec for string leaves. Core owns the mapping from facts to item changes. */
export function restoreAppend(input: unknown, patch: Append): unknown {
  const descend = (value: unknown, path: Append["path"]): unknown => {
    const [key, ...rest] = path;
    if (key === undefined) {
      if (value !== undefined && typeof value !== "string")
        throw new Error("Invalid saved append target");
      return (value ?? "") + patch.text;
    }
    if (typeof key === "number") {
      const array = z.array(z.unknown()).parse(value ?? []);
      array[key] = descend(array[key], rest);
      return array;
    }
    const object = z
      .record(z.string(), z.unknown())
      .parse(value ?? (rest.length ? {} : (patch.seed ?? {})));
    Object.defineProperty(object, key, {
      value: descend(Object.hasOwn(object, key) ? object[key] : undefined, rest),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return object;
  };
  return descend(input, patch.path);
}
