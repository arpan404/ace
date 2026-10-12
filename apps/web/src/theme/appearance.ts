import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { defaultThemeId, themeIds, type Scheme, type ThemeId } from "./palettes.ts";

export const Mode = z.enum(["light", "dark", "system"]);
export type Mode = z.infer<typeof Mode>;
export const SurfaceSetting = z.enum(["translucent", "solid"]);
export type SurfaceSetting = z.infer<typeof SurfaceSetting>;
/** "on" reduces motion; "system" follows `prefers-reduced-motion`. */
export const ReduceMotion = z.enum(["system", "on", "off"]);
export type ReduceMotion = z.infer<typeof ReduceMotion>;
export const Density = z.enum(["comfortable", "compact"]);
export type Density = z.infer<typeof Density>;
export const TranscriptSize = z.enum(["small", "default", "large"]);
export type TranscriptSize = z.infer<typeof TranscriptSize>;

/** Local, per-device appearance. Daemon settings live in the daemon, not here. */
export const Appearance = z.object({
  mode: z.catch(Mode, "system"),
  theme: z.catch(z.enum(themeIds), defaultThemeId),
  surface: z.catch(SurfaceSetting, "translucent"),
  reduceMotion: z.catch(ReduceMotion, "system"),
  density: z.catch(Density, "comfortable"),
  transcriptSize: z.catch(TranscriptSize, "default"),
});
export type Appearance = z.infer<typeof Appearance>;

export const defaultAppearance: Appearance = {
  mode: "system",
  theme: defaultThemeId,
  surface: "translucent",
  reduceMotion: "system",
  density: "comfortable",
  transcriptSize: "default",
};

export const transcriptSizes: Record<TranscriptSize, { px: number; label: string }> = {
  small: { px: 13, label: "Small" },
  default: { px: 14, label: "Default" },
  large: { px: 17, label: "Large" },
};

const storageKey = "ace.appearance";

export function loadAppearance(storage: KeyValueStorage | undefined): Appearance {
  return readJson(storage, storageKey, Appearance, defaultAppearance);
}
export function saveAppearance(storage: KeyValueStorage | undefined, value: Appearance): void {
  writeJson(storage, storageKey, value);
}

/** The operating system's preferences that appearance settings can defer to. */
export interface SystemPreferences {
  dark: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}

/** What the page actually shows once "system" and the OS's accessibility settings are applied. */
export interface ResolvedAppearance {
  theme: ThemeId;
  scheme: Scheme;
  /** Translucent falls back to solid while the OS reduces transparency. */
  surface: SurfaceSetting;
  reduceMotion: boolean;
}

export function resolveAppearance(
  appearance: Appearance,
  system: SystemPreferences,
): ResolvedAppearance {
  return {
    theme: appearance.theme,
    scheme: appearance.mode === "system" ? (system.dark ? "dark" : "light") : appearance.mode,
    surface: appearance.surface === "solid" || system.reducedTransparency ? "solid" : "translucent",
    reduceMotion:
      appearance.reduceMotion === "system"
        ? system.reducedMotion
        : appearance.reduceMotion === "on",
  };
}

/**
 * What `index.html` replays before first paint, so a reload never flashes the wrong theme: the
 * settings (it resolves "system" against the OS itself) and the chosen theme's stylesheet.
 * Written by the theme provider whenever either changes.
 */
export interface BootAppearance {
  theme: ThemeId;
  mode: Mode;
  surface: SurfaceSetting;
  reduceMotion: ReduceMotion;
  density: Density;
  transcriptPx: number;
  css: string;
}
export const bootAppearanceKey = "ace.boot-appearance";
