const secretKey =
  /authorization|password|cookie|api.?key|credential|access.?token|refresh.?token|headers|settings|providerState|resultState/i;
/** Bounded unknown evidence; secrets are removed before observation or translation. */
export function sanitize(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") {
    let result = value.slice(0, 1048576);
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redacted]");
    return result.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, 2048).map((v) => sanitize(v, secrets, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 2048)
        .map(([k, v]) => [k, secretKey.test(k) ? "[redacted]" : sanitize(v, secrets, depth + 1)]),
    );
  }
  return value;
}
