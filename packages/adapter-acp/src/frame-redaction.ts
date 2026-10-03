/** Redact exact ephemeral lease material, retaining unchanged frames without copying. */
export function redactLease(data: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return data;
  const replace = (value: unknown, depth: number): unknown => {
    if (depth > 64) return "[depth limit]";
    if (typeof value === "string") {
      let text = value;
      for (const secret of secrets)
        if (secret && text.includes(secret)) text = text.split(secret).join("[ace lease redacted]");
      return text;
    }
    if (Array.isArray(value)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const child = replace(value[i], depth + 1);
        if (child !== value[i]) {
          copy ??= [...value];
          copy[i] = child;
        }
      }
      return copy ?? value;
    }
    if (value && typeof value === "object") {
      let copy: Record<string, unknown> | undefined;
      for (const [key, original] of Object.entries(value)) {
        const child = replace(original, depth + 1);
        if (child !== original) {
          copy ??= Object.fromEntries(Object.entries(value));
          Object.defineProperty(copy, key, {
            value: child,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return copy ?? value;
    }
    return value;
  };
  return replace(data, 0);
}
