/** No credentials are read; recognised secrets in untrusted content are scrubbed. */
export function redact(text: string): string {
  return text
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/((?:authorization|(?:github|gh)[_-]?token)\s*[=:]\s*)[^\r\n,}]+/gi, "$1[REDACTED]");
}
export function redactData(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redact(key);
      Object.defineProperty(result, safeKey, {
        value: /token|authorization|password|secret/i.test(key) ? "[REDACTED]" : redactData(entry),
        enumerable: true,
      });
    }
    return result;
  }
  return value;
}
