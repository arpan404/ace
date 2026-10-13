import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { accentIds, defaultCustomAccent } from "./accent.ts";
import { defaultThemeId, themeIds, themes, type Scheme, type ThemeId } from "./palettes.ts";
import { defaultTranslucency, snapTranslucency, translucencyMax } from "./translucency.ts";

export const Mode = z.enum(["light", "dark", "system"]);
export type Mode = z.infer<typeof Mode>;
/** What floating layers resolve to: glass, or solid with no backdrop filter. */
export type SurfaceSetting = "translucent" | "solid";
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
  /** Laid over any theme; "theme" keeps the theme's own (accent.ts). */
  accent: z.catch(z.enum(accentIds), "theme"),
  customAccent: z.catch(z.string().check(z.regex(/^#[0-9a-f]{6}$/i)), defaultCustomAccent),
  /** 0 is solid; `translucencyMax` is the theme's most translucent AA-safe glass. */
  translucency: z.catch(z.int().check(z.gte(0), z.lte(translucencyMax)), defaultTranslucency),
  reduceMotion: z.catch(ReduceMotion, "system"),
  density: z.catch(Density, "comfortable"),
  transcriptSize: z.catch(TranscriptSize, "default"),
});
export type Appearance = z.infer<typeof Appearance>;

export const defaultAppearance: Appearance = {
  mode: "system",
  theme: defaultThemeId,
  accent: "theme",
  customAccent: defaultCustomAccent,
  translucency: defaultTranslucency,
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

/** The Surfaces choice the slider replaced, read only to carry it over. */
const EarlierSurfaces = z.object({
  surface: z.optional(z.unknown()),
  translucency: z.optional(z.unknown()),
});

export function loadAppearance(storage: KeyValueStorage | undefined): Appearance {
  const saved = readJson(storage, storageKey, Appearance, defaultAppearance);
  // Surfaces: Solid becomes Solid on the slider; Translucent is the default glass already.
  const earlier = readJson(storage, storageKey, EarlierSurfaces, {});
  const wasSolid = earlier.translucency === undefined && earlier.surface === "solid";
  return wasSolid ? { ...saved, translucency: 0 } : saved;
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
  /**
   * Solid at translucency 0, while the OS reduces transparency, and in a theme whose layers are
   * always solid (Signal); translucent otherwise.
   */
  surface: SurfaceSetting;
  /** The translucency on screen: the setting, or 0 wherever the layers are solid. */
  translucency: number;
  reduceMotion: boolean;
}

/** Whether a theme's floating layers can be glass at all in `scheme`; Signal's never are. */
export function themeHasGlass(theme: ThemeId, scheme: Scheme): boolean {
  return themes[theme][scheme].material.glass !== null;
}

export function resolveAppearance(
  appearance: Appearance,
  system: SystemPreferences,
): ResolvedAppearance {
  const scheme = appearance.mode === "system" ? (system.dark ? "dark" : "light") : appearance.mode;
  const translucency = snapTranslucency(appearance.translucency);
  const solid =
    translucency === 0 || system.reducedTransparency || !themeHasGlass(appearance.theme, scheme);
  return {
    theme: appearance.theme,
    scheme,
    surface: solid ? "solid" : "translucent",
    translucency: solid ? 0 : translucency,
    reduceMotion:
      appearance.reduceMotion === "system"
        ? system.reducedMotion
        : appearance.reduceMotion === "on",
  };
}

/**
 * What `index.html` replays before first paint, so a reload never flashes the wrong theme: the
 * settings (it resolves "system" against the OS itself) and the chosen theme's stylesheet, its
 * glass at the chosen translucency. Written by the theme provider whenever either changes.
 */
export interface BootAppearance {
  theme: ThemeId;
  mode: Mode;
  surface: SurfaceSetting;
  translucency: number;
  reduceMotion: ReduceMotion;
  density: Density;
  transcriptPx: number;
  css: string;
}
export const bootAppearanceKey = "ace.boot-appearance";
