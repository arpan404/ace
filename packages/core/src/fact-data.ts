/** Provider facts must survive JSON snapshots without executable or cyclic data. */
export function isFactData(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  try {
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => "value" in descriptor && isFactData(descriptor.value, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Schema defaults may add fields; unknown provider fields must not disappear. */
export function preservesFields(input: unknown, parsed: unknown): boolean {
  if (input === undefined) return true;
  if (input === null || typeof input !== "object") return input === parsed;
  if (parsed === null || typeof parsed !== "object") return false;
  const output = parsed as Record<string, unknown>;
  return Object.entries(input).every(
    ([key, value]) =>
      value === undefined || (Object.hasOwn(output, key) && preservesFields(value, output[key])),
  );
}

export function validData(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
): boolean {
  const result = schema.safeParse(value);
  return result.success && preservesFields(value, result.data);
}
