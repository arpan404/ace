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
      const entries = Object.entries(value);
      let copy: Record<string, unknown> | undefined;
      // Reserve original keys so redacted keys cannot overwrite an existing field.
      const used = new Set(entries.map(([key]) => key));
      const suffixes = new Map<string, number>();
      for (const [key, original] of entries) {
        const child = replace(original, depth + 1);
        const safeKey = replace(key, depth + 1);
        if (typeof safeKey !== "string") throw new Error("Invalid redacted key");
        if (child === original && safeKey === key) continue;
        copy ??= Object.fromEntries(entries);
        let target = safeKey;
        if (safeKey !== key) {
          delete copy[key];
          let suffix = suffixes.get(safeKey) ?? 1;
          while (used.has(target)) target = `${safeKey}#${suffix++}`;
          suffixes.set(safeKey, suffix);
          used.add(target);
        }
        Object.defineProperty(copy, target, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return copy ?? value;
    }
    return value;
  };
  return replace(data, 0);
}
