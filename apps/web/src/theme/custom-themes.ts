import { z } from "zod";
import { type KeyValueStorage } from "@ace/ui-core";
import { basePreset, type Theme } from "./presets.ts";
import { tokenNames, type ThemeTokens } from "./tokens.ts";

const storageKey = "ace.themes";

/** A theme file as exported, imported and stored: `{ id, name, scheme, tokens }`. */
export const ThemeFile = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80).catch("Imported theme"),
  scheme: z.enum(["light", "dark"]).catch("dark"),
  tokens: z.record(z.string(), z.string().max(200)),
});
export type ThemeFile = z.infer<typeof ThemeFile>;

/** Unknown tokens are dropped; missing ones come from the base preset of the same scheme. */
export function themeFromFile(file: ThemeFile, id: string): Theme {
  const base = basePreset(file.scheme).tokens;
  const tokens = { ...base };
  for (const name of tokenNames) {
    const value = file.tokens[name];
    if (value !== undefined && value.trim()) tokens[name] = value.trim();
  }
  return { id, name: file.name, scheme: file.scheme, tokens, preset: false };
}

export function themeToFile(theme: Theme): string {
  return JSON.stringify(
    { id: theme.id, name: theme.name, scheme: theme.scheme, tokens: theme.tokens },
    null,
    2,
  );
}

/** Parse a user-supplied theme file. Throws a readable error when it is not a theme. */
export function parseThemeFile(text: string): ThemeFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const file = ThemeFile.safeParse(json);
  if (!file.success || file.data.tokens["--background"] === undefined)
    throw new Error("That file isn't an ace theme: it needs a tokens object with --background.");
  return file.data;
}

/** The editor forks a preset into an editable copy on the first change. */
export function forkTheme(source: Theme, id: string, name = `${source.name} copy`): Theme {
  return { id, name, scheme: source.scheme, tokens: { ...source.tokens }, preset: false };
}

export function withToken(theme: Theme, name: keyof ThemeTokens, value: string): Theme {
  return { ...theme, tokens: { ...theme.tokens, [name]: value } };
}

export function loadCustomThemes(storage: KeyValueStorage | undefined): Theme[] {
  try {
    const raw = storage?.getItem(storageKey);
    if (!raw) return [];
    const files = z.array(ThemeFile).catch([]).parse(JSON.parse(raw));
    return files.flatMap((file) => (file.id ? [themeFromFile(file, file.id)] : []));
  } catch {
    return [];
  }
}

export function saveCustomThemes(storage: KeyValueStorage | undefined, themes: readonly Theme[]) {
  try {
    storage?.setItem(
      storageKey,
      JSON.stringify(themes.map(({ id, name, scheme, tokens }) => ({ id, name, scheme, tokens }))),
    );
  } catch {
    /* Quota or private mode: custom themes stay in memory for this session. */
  }
}
