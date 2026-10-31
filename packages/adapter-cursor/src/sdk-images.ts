/** Local SDK 1.0.35 returns MCP image.data as bytes despite its string schema.
 * Copy only changed containers, without invoking vendor getters or toJSON. */
export function sdkImages(body: unknown, maxBytes: number): unknown {
  let nodes = 0;
  let imageBytes = 0;
  const byteLength = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength",
  )?.get;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number, field?: string): unknown => {
    if (++nodes > 32768 || depth > 64) throw new RangeError("SDK image structure exceeds budget");
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
    if (ancestors.has(value)) throw new TypeError("Cyclic SDK payload");
    ancestors.add(value);
    let descriptors: PropertyDescriptorMap | undefined;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("SDK getter rejected");
      const child: unknown = descriptor.value;
      let normalized: unknown;
      if (field === "image" && key === "data" && child instanceof Uint8Array) {
        const size: unknown = byteLength?.call(child);
        if (typeof size !== "number") throw new TypeError("Invalid SDK image bytes");
        imageBytes += 4 * Math.ceil(size / 3);
        if (imageBytes > maxBytes) throw new RangeError("SDK image exceeds streaming budget");
        // A fresh native view avoids user-defined byteLength/length/iterator getters.
        normalized = Buffer.from(new Uint8Array(child)).toString("base64");
      } else normalized = visit(child, depth + 1, key);
      if (normalized !== child) {
        descriptors ??= Object.getOwnPropertyDescriptors(value);
        descriptors[key] = { ...descriptor, value: normalized };
      }
    }
    ancestors.delete(value);
    if (!descriptors) return value;
    return Array.isArray(value)
      ? Object.defineProperties([], descriptors)
      : Object.create(prototype, descriptors);
  };
  return visit(body, 0);
}
