import { applyEdits, modify, parse, visit, type ParseError } from "jsonc-parser";
import {
  SettingsDocument,
  SettingsValues,
  SettingsKey,
  type SettingsDiagnostic,
} from "@ace/protocol";
import { z } from "zod";

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
      const words = key.replace(/([a-z])([A-Z])/g, "$1_$2");
      if (
        /(?:^|[._\-\s])(?:tokens?|keys?|passwords?|secrets?|credentials?|authorization)(?:$|[._\-\s])/i.test(
          words,
        ) ||
        /(?:api|access|refresh|private|secret)(?:key|token)/i.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        throw new SettingsError("secret", "Secret-looking fields cannot be stored in settings");
      guardSecrets(item, depth + 1);
    }
  }
}
export function validateAssignment(
  key: string,
  value: unknown,
): { key: SettingsKey; value: SettingsValues[SettingsKey] } {
  guardSecrets({ [key]: value });
  const parsed = SettingsKey.safeParse(key);
  if (!parsed.success) throw new SettingsError("validation", "Unknown settings key");
  return { key: parsed.data, value: validateValue(parsed.data, value) };
}
export function validateValue<K extends SettingsKey>(key: K, value: unknown): SettingsValues[K] {
  guardSecrets({ [key]: value });
  if (
    key.startsWith("clients.") &&
    Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_CLIENT_BYTES
  )
    throw new SettingsError("size", "Client settings blob exceeds 64 KiB");
  const result = SettingsValues.shape[key].safeParse(value);
  if (!result.success) throw new SettingsError("validation", `Invalid value for ${key}`);
  // The selected schema validates the indexed key; TypeScript loses that correlation.
  return result.data as SettingsValues[K];
}
export function edit(text: string, path: string[], value: unknown): string {
  const indentation = /\n([\t ]+)"/.exec(text)?.[1] ?? "  ";
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        insertSpaces: !indentation.includes("\t"),
        tabSize: indentation.length,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}
const envelope = z.object({ version: z.number().int() }).passthrough();
const v1 = z
  .object({ version: z.literal(1), values: z.record(z.string(), z.json()) })
  .passthrough();
export function decode(text: string): {
  document: SettingsDocument;
  text: string;
  migrated: boolean;
} {
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    throw new SettingsError("size", "Settings document exceeds 1 MiB");
  let depth = 0;
  const begin = () => {
    if (++depth > 64) throw new SettingsError("size", "Settings nesting exceeds 64 levels");
  };
  const end = () => {
    depth--;
  };
  visit(
    text,
    { onObjectBegin: begin, onArrayBegin: begin, onObjectEnd: end, onArrayEnd: end },
    { allowTrailingComma: true },
  );
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new SettingsError("parse", "Invalid JSONC settings", errors[0]?.offset);
  guardSecrets(raw);
  guardSecrets(text);
  const header = envelope.safeParse(raw);
  if (!header.success)
    throw new SettingsError("validation", "Settings require a versioned document");
  let migrated = false;
  if (header.data.version === 1) {
    const old = v1.safeParse(raw);
    if (!old.success || Object.hasOwn(old.data, "settings"))
      throw new SettingsError("validation", "Invalid version 1 settings document");
    text = edit(
      edit(edit(text, ["settings"], old.data.values), ["values"], undefined),
      ["version"],
      2,
    );
    migrated = true;
  } else if (header.data.version !== 2) {
    throw new SettingsError("version", "Unsupported settings document version");
  }
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    throw new SettingsError("size", "Migrated settings document exceeds 1 MiB");
  const data: unknown = migrated ? parse(text) : raw;
  const result = SettingsDocument.safeParse(data);
  if (!result.success)
    throw new SettingsError("validation", "Settings document has invalid known values");
  for (const key of ["clients.theme", "clients.keybindings"] as const) {
    if (Object.hasOwn(result.data.settings, key)) validateValue(key, result.data.settings[key]);
  }
  return { document: result.data, text, migrated };
}
export const emptyText = '{\n  "version": 2,\n  "settings": {}\n}\n';
