const secret = /authorization|cookie|token|secret|password|credential|api[_-]?key|headers|env/i;
function redact(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[depth limit]";
  if (Array.isArray(value)) return value.map((child) => redact(child, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secret.test(key) ? "[redacted]" : redact(child, depth + 1),
      ]),
    );
  }
  return value;
}
export function rawPayload(value: unknown): { json: string; truncated: boolean } {
  const bytes = Buffer.from(JSON.stringify(redact(value)) ?? "null");
  if (bytes.length <= 2048) return { json: bytes.toString(), truncated: false };
  // Round-trip avoids a partial UTF-8 code point exceeding the byte limit.
  let json = bytes.subarray(0, 2048).toString();
  while (Buffer.byteLength(json) > 2048) json = json.slice(0, -1);
  return { json, truncated: true };
}
