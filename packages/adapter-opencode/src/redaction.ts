import { isNativeRecord } from "@ace/provider-kit/record";

const secretKey =
  /authorization|password|cookie|api.?key|credential|access.?token|refresh.?token|headers|settings|providerState|resultState|encryptedContent|^native$/i;
const credential = /(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/i;
const credentials = new RegExp(credential.source, "gi");
const maxString = 1048576;
const maxEntries = 2048;

/**
 * Bounded unknown evidence; secrets are removed before observation or translation. Copy on
 * write: a value with nothing to redact or bound is returned as is, since this runs on every
 * event and most evidence holds no secret.
 */
export function sanitize(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") {
    let result = value.length > maxString ? value.slice(0, maxString) : value;
    for (const secret of secrets)
      if (secret && result.includes(secret)) result = result.replaceAll(secret, "[redacted]");
    return credential.test(result) ? result.replace(credentials, "[redacted]") : result;
  }
  if (Array.isArray(value)) {
    const count = Math.min(value.length, maxEntries);
    let copy: unknown[] | undefined = value.length > maxEntries ? [] : undefined;
    for (let index = 0; index < count; index++) {
      const original: unknown = value[index];
      const child = sanitize(original, secrets, depth + 1);
      if (!copy && child !== original) copy = value.slice(0, index);
      copy?.push(child);
    }
    return copy ?? value;
  }
  if (value !== null && typeof value === "object") {
    // Only a plain object can stand for itself; anything else is rebuilt from its own fields.
    const plain = isNativeRecord(value);
    const record: Readonly<Record<string, unknown>> = plain ? value : { ...value };
    const keys = Object.keys(record);
    const count = Math.min(keys.length, maxEntries);
    let entries: [string, unknown][] | undefined =
      !plain || keys.length > maxEntries ? [] : undefined;
    for (let index = 0; index < count; index++) {
      const key = keys[index] ?? "";
      const original = record[key];
      const child = secretKey.test(key) ? "[redacted]" : sanitize(original, secrets, depth + 1);
      if (!entries && child !== original)
        entries = keys.slice(0, index).map((earlier) => [earlier, record[earlier]]);
      entries?.push([key, child]);
    }
    return entries ? Object.fromEntries(entries) : value;
  }
  return value;
}
