import { providerPermissionDefaults } from "@ace/provider-kit/permission-modes";
import { cursorConfiguration } from "./cursor-configuration.ts";
import { guardSecrets, MAX_CLIENT_BYTES, MAX_DOCUMENT_BYTES, SettingsError } from "./validation.ts";
import { parseDocument, type ScalarRange } from "./jsonc.ts";
export { MAX_DOCUMENT_BYTES, MAX_CLIENT_BYTES, SettingsError } from "./validation.ts";
import { applyEdits, modify } from "jsonc-parser";
import { SettingsDocument, SettingsValues, SettingsKey } from "@ace/protocol";
import { z } from "zod";
import { legacyPermissionMode, migrateProviderPermissions } from "./legacy-permissions.ts";

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
  return (
    key === "providers.configuration"
      ? cursorConfiguration(SettingsValues.shape["providers.configuration"].parse(result.data))
      : result.data
  ) as SettingsValues[K];
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
const knownValues = SettingsValues.partial();
const envelope = z.object({ version: z.number().int() }).passthrough();
const v1 = z
  .object({ version: z.literal(1), values: z.record(z.string(), z.json()) })
  .passthrough();
export interface DecodedDocument {
  document: { version: 2; settings: z.infer<typeof knownValues> };
  text: string;
  bytes: number;
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
  if (migrated) scanned = parseDocument(text);
  const data: unknown = scanned.value;
  const result = SettingsDocument.safeParse(data);
  if (!result.success)
    throw new SettingsError("validation", "Settings document has invalid known values");
  for (const key of ["clients.theme", "clients.keybindings"] as const) {
    if (Object.hasOwn(result.data.settings, key)) validateValue(key, result.data.settings[key]);
  }
  const legacy =
    result.data.settings["permissions.defaultMode"] ??
    (result.data.settings["approvals.policy"]
      ? legacyPermissionMode(result.data.settings["approvals.policy"])
      : undefined);
  if (legacy) {
    const modes = {
      ...providerPermissionDefaults(legacy),
      ...result.data.settings["permissions.providerModes"],
    };
    text = edit(text, ["settings", "permissions.providerModes"], modes);
    text = edit(text, ["settings", "permissions.defaultMode"], null);
    text = edit(text, ["settings", "approvals.policy"], undefined);
    return { ...decode(text), migrated: true };
  }
  if (result.data.settings["approvals.policy"] !== undefined)
    return { ...decode(edit(text, ["settings", "approvals.policy"], undefined)), migrated: true };
  const providerModes = result.data.settings["permissions.providerModes"];
  if (providerModes) {
    const next = migrateProviderPermissions(providerModes);
    if (JSON.stringify(next) !== JSON.stringify(providerModes))
      return {
        ...decode(edit(text, ["settings", "permissions.providerModes"], next)),
        migrated: true,
      };
  }
  const configuration = result.data.settings["providers.configuration"];
  if (configuration) {
    const next = cursorConfiguration(configuration);
    if (JSON.stringify(next) !== JSON.stringify(configuration))
      return {
        ...decode(edit(text, ["settings", "providers.configuration"], next)),
        migrated: true,
      };
  }
  // Unknown data stays in validated source text, never in the hot resolution cache.
  const document = { version: 2 as const, settings: knownValues.parse(result.data.settings) };
  return { document, text, migrated, ranges: scanned.ranges, bytes: scanned.bytes };
}
export const emptyText = '{\n  "version": 2,\n  "settings": {}\n}\n';

/** Reuse only validated offsets and primitive values. Complex insertions use the full decoder. */
export function assign(source: DecodedDocument, key: SettingsKey, value: unknown): DecodedDocument {
  const parsed = validateValue(key, value);
  if (
    (key === "permissions.defaultMode" && typeof parsed === "string") ||
    key === "approvals.policy"
  ) {
    const legacy =
      key === "approvals.policy" ? legacyPermissionMode(parsed) : z.string().parse(parsed);
    let text = edit(source.text, ["settings", "permissions.providerModes"], {
      ...source.document.settings["permissions.providerModes"],
      ...providerPermissionDefaults(legacy),
    });
    text = edit(text, ["settings", "permissions.defaultMode"], null);
    text = edit(text, ["settings", "approvals.policy"], undefined);
    return decode(text);
  }

  const range = source.ranges.get(key);
  if (
    key === "permissions.defaultMode" ||
    !range ||
    (parsed !== null && typeof parsed === "object")
  )
    return decode(edit(source.text, ["settings", key], parsed));
  const content = JSON.stringify(parsed);
  const bytes =
    source.bytes -
    Buffer.byteLength(source.text.slice(range.offset, range.offset + range.length)) +
    Buffer.byteLength(content);
  if (bytes > MAX_DOCUMENT_BYTES)
    throw new SettingsError("size", "Settings document exceeds 1 MiB");
  const text =
    source.text.slice(0, range.offset) + content + source.text.slice(range.offset + range.length);
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
    bytes,
    migrated: source.migrated,
    ranges,
    document: { ...source.document, settings: { ...source.document.settings, [key]: parsed } },
  };
}
