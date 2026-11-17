import { z } from "zod";
import { JsonValue, SettingsValues, type SettingsEntry, type SettingsKey } from "@ace/protocol";
import type { CliConfigEntry } from "@ace/protocol/cli-outputs";
import { parseByteSize } from "@ace/diagnostics/log-policy";
import { keyAliases, settingEnv, settingSummaries, unsettable } from "./config-catalog.ts";
import { CliFailure, usageFailure } from "./output.ts";
import { nearest } from "./suggest.ts";

/**
 * `ace config` keys (ADR 0176 §7): every global setting the app's Settings writes, by its
 * settings key, plus the first CLI's three short names. Pure: values are parsed from the
 * command line and checked against the same schema the daemon checks them with again.
 */

export type ConfigKind = "switch" | "choice" | "number" | "text" | "list" | "file";

export interface ConfigKey {
  readonly key: SettingsKey;
  readonly summary: string;
  readonly kind: ConfigKind;
  /** `none` clears it to null. */
  readonly nullable: boolean;
  readonly choices?: readonly string[];
  /** What it takes, for the error and `ace config get`: "on or off". */
  readonly takes: string;
  readonly env?: string;
}

const shape: Readonly<Record<SettingsKey, z.ZodType>> = SettingsValues.shape;
const keyNames = Object.keys(shape).filter((name): name is SettingsKey => name in shape);

function describe(key: SettingsKey, summary: string): ConfigKey {
  let schema: z.core.$ZodType = shape[key];
  const nullable = schema instanceof z.ZodNullable;
  if (schema instanceof z.ZodNullable) schema = schema.unwrap();
  const base = { key, summary, nullable, ...(settingEnv[key] ? { env: settingEnv[key] } : {}) };
  const orNone = nullable ? ", or none" : "";
  if (schema instanceof z.ZodBoolean) return { ...base, kind: "switch", takes: "on or off" };
  if (schema instanceof z.ZodEnum) {
    const choices = schema.options.map(String);
    return { ...base, kind: "choice", choices, takes: `${choiceWords(choices)}${orNone}` };
  }
  if (schema instanceof z.ZodNumber) {
    const { minValue, maxValue } = schema;
    const range = minValue !== null && maxValue !== null ? ` from ${minValue} to ${maxValue}` : "";
    return { ...base, kind: "number", takes: `a whole number${range}${orNone}` };
  }
  if (schema instanceof z.ZodString) return { ...base, kind: "text", takes: `text${orNone}` };
  if (schema instanceof z.ZodArray && schema.element instanceof z.ZodString)
    return { ...base, kind: "list", takes: "a comma-separated list; empty for none" };
  return { ...base, kind: "file", takes: `@FILE, a JSON file${orNone}` };
}

function choiceWords(choices: readonly string[]): string {
  if (choices.length < 2) return choices.join("");
  return `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}`;
}

/** Every key `ace config` lists, in the schema's order (the order Settings shows them in). */
export const configKeys: readonly ConfigKey[] = keyNames.flatMap((key) => {
  const summary = settingSummaries[key];
  return summary && !unsettable[key] ? [describe(key, summary)] : [];
});
const byKey = new Map(configKeys.map((entry) => [entry.key, entry]));

/** The three short names read the way the first CLI printed them. */
const shortTakes: Readonly<Partial<Record<SettingsKey, string>>> = {
  "storage.retentionDays": "a whole number of days from 1 to 3650",
  "logs.maxBytes": "a size from 1m to 64g, such as 512m or 1g",
  "worktree.preparationTimeoutMs":
    "milliseconds from 60000 to 3600000, such as 600000 for 10 minutes",
};

/** A typed name, as a key; unknown names are a usage error with the nearest key. */
export function resolveConfigKey(name: string): ConfigKey {
  const key = keyAliases[name] ?? name;
  const found = byKey.get(key as SettingsKey);
  if (found)
    return shortTakes[found.key] ? { ...found, takes: shortTakes[found.key] ?? "" } : found;
  const reason = unsettable[key as SettingsKey];
  if (reason)
    throw new CliFailure("refused", `${key} ${reason}.`, undefined, {
      code: "refused",
      argument: "KEY",
      hint: "See the settings you can change with ace config list.",
    });
  const suggestion = nearest(name, [...byKey.keys(), ...Object.keys(keyAliases)]);
  throw usageFailure(`ace has no setting ${name}.`, {
    code: "bad_argument",
    argument: "KEY",
    hint: suggestion
      ? `Did you mean ${suggestion}? See every setting with ace config list.`
      : "See every setting with ace config list.",
  });
}

const switchWords: Readonly<Record<string, boolean>> = {
  on: true,
  off: false,
  true: true,
  false: false,
  yes: true,
  no: false,
};

/**
 * The value `raw` stands for, checked against the setting's schema. `@FILE` reads JSON from a
 * file (for structured settings); `readFile` is the only way out of this function.
 */
export async function parseConfigValue(
  entry: ConfigKey,
  name: string,
  raw: string,
  readFile: (path: string) => Promise<string>,
): Promise<JsonValue> {
  const candidate = await candidateValue(entry, raw, readFile);
  const checked = shape[entry.key].safeParse(candidate);
  if (checked.success) return JsonValue.parse(checked.data);
  throw usageFailure(`${name} must be ${entry.takes}.`, {
    code: "bad_argument",
    argument: "VALUE",
    hint: `${entry.summary}. See it with ace config get ${name}.`,
  });
}

async function candidateValue(
  entry: ConfigKey,
  raw: string,
  readFile: (path: string) => Promise<string>,
): Promise<unknown> {
  const text = raw.trim();
  if (entry.nullable && text.toLowerCase() === "none") return null;
  if (text.startsWith("@")) return readJson(text.slice(1), readFile);
  switch (entry.kind) {
    case "switch":
      return switchWords[text.toLowerCase()];
    case "choice":
    case "text":
      return raw;
    case "number":
      if (entry.key === "logs.maxBytes") return parseByteSize(text) ?? Number.NaN;
      return /^\d+$/.test(text) ? Number(text) : Number.NaN;
    case "list":
      return text
        ? text
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    case "file":
      return undefined;
  }
}

async function readJson(path: string, readFile: (path: string) => Promise<string>) {
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    throw usageFailure(`Couldn't read ${path}.`, {
      code: "bad_argument",
      argument: "VALUE",
      hint: "Pass @FILE with the path of a JSON file.",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageFailure(`${path} isn't JSON.`, {
      code: "bad_argument",
      argument: "VALUE",
      hint: "Write the value as JSON in that file.",
    });
  }
}

/** A value as a person reads it: on/off, none, sizes and durations for the short names. */
export function formatConfigValue(key: SettingsKey, value: unknown): string {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") {
    if (key === "storage.retentionDays") return `${value} days`;
    if (key === "logs.maxBytes") return formatBytes(value);
    if (key === "worktree.preparationTimeoutMs")
      return value % 60_000 === 0 ? `${value / 60_000} minutes` : `${value} ms`;
    return String(value);
  }
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.length ? value.join(", ") : "none";
  return JSON.stringify(value);
}

function formatBytes(bytes: number): string {
  for (const [unit, scale] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const)
    if (bytes >= scale && bytes % scale === 0) return `${bytes / scale} ${unit}`;
  return `${bytes} bytes`;
}

/** What `ace config` reports for one setting, from the entry the settings service resolved. */
export function configEntry(
  name: string,
  entry: ConfigKey,
  resolved: Pick<SettingsEntry, "value" | "provenance">,
  live: boolean,
): CliConfigEntry {
  const environment = resolved.provenance === "environment";
  return {
    setting: name,
    key: entry.key,
    value: resolved.value,
    source: environment ? "environment" : resolved.provenance === "defaults" ? "default" : "saved",
    ...(environment && entry.env ? { overriddenBy: entry.env } : {}),
    live,
  };
}
