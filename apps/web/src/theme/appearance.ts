import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { accentNames } from "./presets.ts";

export const AccentChoice = z.enum([...accentNames, "custom"]);
export type AccentChoice = z.infer<typeof AccentChoice>;
export const Density = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof Density>;
export const TranscriptSize = z.enum(["small", "default", "large"]);
export type TranscriptSize = z.infer<typeof TranscriptSize>;
export const HexColor = z.string().check(z.regex(/^#[0-9a-f]{6}$/i));

/**
 * The theme a first visit gets: the OS's light or dark. The provider resolves "system" from
 * `prefers-color-scheme` before its first render, and `index.html` does the same from the boot
 * record, so the first frame is already in the right scheme.
 */
export const defaultTheme = "system";

/** Local, per-device appearance. Daemon settings live in the daemon, not here. */
export const Appearance = z.object({
  /** "system", a preset id or a custom theme id. */
  theme: z.catch(z.string().check(z.minLength(1)), defaultTheme),
  accent: z.catch(AccentChoice, "blue"),
  customAccent: z.catch(HexColor, "#7AA2F7"),
  /** 0 = solid, 1 = the most wallpaper shows through. */
  glass: z.catch(z.number().check(z.gte(0), z.lte(1)), 1),
  density: z.catch(Density, "comfortable"),
  transcriptSize: z.catch(TranscriptSize, "default"),
});
export type Appearance = z.infer<typeof Appearance>;

export const defaultAppearance: Appearance = {
  theme: defaultTheme,
  accent: "blue",
  customAccent: "#7AA2F7",
  glass: 1,
  density: "comfortable",
  transcriptSize: "default",
};

export const transcriptSizes: Record<TranscriptSize, { px: number; label: string }> = {
  small: { px: 14.5, label: "Small (14.5px)" },
  default: { px: 15.5, label: "Default (15.5px)" },
  large: { px: 17, label: "Large (17px)" },
};

const storageKey = "ace.appearance";

export function loadAppearance(storage: KeyValueStorage | undefined): Appearance {
  return readJson(storage, storageKey, Appearance, defaultAppearance);
}
export function saveAppearance(storage: KeyValueStorage | undefined, value: Appearance): void {
  writeJson(storage, storageKey, value);
}

/**
 * What `index.html` applies before first paint, so a reload never flashes the wrong theme.
 * Written by the theme provider whenever the applied theme changes.
 */
export interface BootTheme {
  system: boolean;
  theme: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  css: string;
}
export const bootThemeKey = "ace.boot-theme";
