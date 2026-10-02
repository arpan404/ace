import { guardSecrets, MAX_CLIENT_BYTES, MAX_DOCUMENT_BYTES, SettingsError } from "./validation.ts";
import { parseDocument, type ScalarRange } from "./jsonc.ts";
export { MAX_DOCUMENT_BYTES, MAX_CLIENT_BYTES, SettingsError } from "./validation.ts";
import { applyEdits, modify } from "jsonc-parser";
import { SettingsDocument, SettingsValues, SettingsKey } from "@ace/protocol";
import { z } from "zod";

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
export interface DecodedDocument {
  document: SettingsDocument;
  text: string;
  migrated: boolean;
  ranges: Map<SettingsKey, ScalarRange>;
}
export function decode(text: string): DecodedDocument {
  let scanned = parseDocument(text);
  const raw = scanned.value;
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
  if (migrated) scanned = parseDocument(text);
  const data: unknown = scanned.value;
  const result = SettingsDocument.safeParse(data);
  if (!result.success)
    throw new SettingsError("validation", "Settings document has invalid known values");
  for (const key of ["clients.theme", "clients.keybindings"] as const) {
    if (Object.hasOwn(result.data.settings, key)) validateValue(key, result.data.settings[key]);
  }
  return { document: result.data, text, migrated, ranges: scanned.ranges };
}
export const emptyText = '{\n  "version": 2,\n  "settings": {}\n}\n';

/** Reuse only validated offsets and primitive values. Complex insertions use the full decoder. */
export function assign(source: DecodedDocument, key: SettingsKey, value: unknown): DecodedDocument {
  const parsed = validateValue(key, value);
  const range = source.ranges.get(key);
  if (!range || (parsed !== null && typeof parsed === "object"))
    return decode(edit(source.text, ["settings", key], parsed));
  const content = JSON.stringify(parsed);
  const text =
    source.text.slice(0, range.offset) + content + source.text.slice(range.offset + range.length);
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    throw new SettingsError("size", "Settings document exceeds 1 MiB");
  const shift = content.length - range.length;
  const ranges = new Map<SettingsKey, ScalarRange>();
  for (const [other, position] of source.ranges)
    ranges.set(
      other,
      other === key
        ? { offset: range.offset, length: content.length }
        : {
            offset: position.offset > range.offset ? position.offset + shift : position.offset,
            length: position.length,
          },
    );
  return {
    text,
    migrated: source.migrated,
    ranges,
    document: { ...source.document, settings: { ...source.document.settings, [key]: parsed } },
  };
}
