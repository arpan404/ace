import { SettingsKey } from "@ace/protocol";
import { parse, visit } from "jsonc-parser";
import { guardProperty, guardSecrets, MAX_DOCUMENT_BYTES, SettingsError } from "./validation.ts";

/** Validate every decoded token before the object parser can overwrite properties. */
export interface ScalarRange {
  offset: number;
  length: number;
}
export function parseDocument(text: string): {
  value: unknown;
  bytes: number;
  ranges: Map<SettingsKey, ScalarRange>;
} {
  const ranges = new Map<SettingsKey, ScalarRange>();
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_DOCUMENT_BYTES)
    throw new SettingsError("size", "Settings document exceeds 1 MiB");
  const objects: (Set<string> | undefined)[] = [];
  let duplicate: number | undefined;
  let syntax: number | undefined;
  const begin = (properties: Set<string> | undefined) => {
    objects.push(properties);
    if (objects.length > 64) throw new SettingsError("size", "Settings nesting exceeds 64 levels");
  };
  visit(
    text,
    {
      onObjectBegin: () => begin(new Set()),
      onArrayBegin: () => begin(undefined),
      onObjectEnd: () => {
        objects.pop();
      },
      onArrayEnd: () => {
        objects.pop();
      },
      onObjectProperty: (key, offset) => {
        guardProperty(key);
        const properties = objects.at(-1);
        if (properties?.has(key)) duplicate ??= offset;
        properties?.add(key);
      },
      onLiteralValue: (value: unknown, offset, length, _line, _character, path) => {
        guardSecrets(value);
        const location = path();
        if (location.length === 2 && location[0] === "settings") {
          const key = SettingsKey.safeParse(location[1]);
          if (key.success) ranges.set(key.data, { offset, length });
        }
      },
      onError: (_code, offset) => {
        syntax ??= offset;
      },
    },
    { allowTrailingComma: true },
  );
  if (syntax !== undefined) throw new SettingsError("parse", "Invalid JSONC settings", syntax);
  // Finish the visitor so credentials in discarded duplicates still get diagnosed.
  if (duplicate !== undefined)
    throw new SettingsError("validation", "Duplicate JSONC property", duplicate);
  guardSecrets(text);
  const raw: unknown = parse(text, [], { allowTrailingComma: true });
  return { value: raw, ranges, bytes };
}
