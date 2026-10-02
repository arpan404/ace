import type { SettingsDiagnostic } from "@ace/protocol";

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_CLIENT_BYTES = 64 * 1024;
export class SettingsError extends Error {
  readonly code: SettingsDiagnostic["code"];
  readonly offset: number | undefined;
  constructor(code: SettingsDiagnostic["code"], message: string, offset?: number) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    this.offset = offset;
  }
}
export function guardSecrets(value: unknown, depth = 0): void {
  if (depth > 64) throw new SettingsError("size", "Settings nesting exceeds 64 levels");
  if (typeof value === "string") {
    if (
      /(?:\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_|AKIA)[a-zA-Z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(
        value,
      )
    )
      throw new SettingsError("secret", "Credentials cannot be stored in settings");
  } else if (Array.isArray(value)) {
    for (const item of value) guardSecrets(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      guardProperty(key);
      guardSecrets(item, depth + 1);
    }
  }
}

export function guardProperty(key: string): void {
  const words = key.replace(/([a-z])([A-Z])/g, "$1_$2");
  if (
    /(?:^|[._\-\s])(?:tokens?|keys?|passwords?|passwd|pwd|secrets?|credentials?|authorization)(?:$|[._\-\s])/i.test(
      words,
    ) ||
    /(?:api|access|refresh|private|secret)(?:key|token)/i.test(key) ||
    ["__proto__", "constructor", "prototype"].includes(key)
  )
    throw new SettingsError("secret", "Secret-looking fields cannot be stored in settings");
}
