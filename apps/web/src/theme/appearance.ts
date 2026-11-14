import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import {
  accentIds,
  defaultCustomAccent,
  defaultThemeId,
  densityIds,
  themeIds,
  themes,
  transcriptSizeIds,
  type Scheme,
  type ThemeId,
} from "@ace/themes";
import { SuitId, type SuitDetail } from "@ace/protocol/suits";
import { suitPalette, suitSchemeFor } from "./suits/suit-css.ts";
import { defaultTranslucency, snapTranslucency, translucencyMax } from "./translucency.ts";

export const Mode = z.enum(["light", "dark", "system"]);
export type Mode = z.infer<typeof Mode>;
/** What floating layers resolve to: glass, or solid with no backdrop filter. */
export type SurfaceSetting = "translucent" | "solid";
/** "on" reduces motion; "system" follows `prefers-reduced-motion`. */
export const ReduceMotion = z.enum(["system", "on", "off"]);
export type ReduceMotion = z.infer<typeof ReduceMotion>;
export const Density = z.enum(densityIds);
export type Density = z.infer<typeof Density>;
export const TranscriptSize = z.enum(transcriptSizeIds);
export type TranscriptSize = z.infer<typeof TranscriptSize>;

/** Local, per-device appearance. Daemon settings live in the daemon, not here. */
export const Appearance = z.object({
  mode: z.catch(Mode, "system"),
  theme: z.catch(z.enum(themeIds), defaultThemeId),
  /** Laid over any theme; "theme" keeps the theme's own (accent.ts). */
  accent: z.catch(z.enum(accentIds), "theme"),
  customAccent: z.catch(z.string().check(z.regex(/^#[0-9a-f]{6}$/i)), defaultCustomAccent),
  /**
   * 0 is solid; `translucencyMax` (100%) is the theme's most translucent AA-safe glass.
   */
  translucency: z.catch(z.int().check(z.gte(0), z.lte(translucencyMax)), defaultTranslucency),
  reduceMotion: z.catch(ReduceMotion, "system"),
  density: z.catch(Density, "comfortable"),
  transcriptSize: z.catch(TranscriptSize, "default"),
  /** The Suit on this device (ADR 0150); it replaces the theme's palette while it can apply. */
  suit: z.catch(z.nullable(SuitId), null),
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
  suit: null,
};

export { transcriptSizes } from "@ace/themes";

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
  const appearance = wasSolid ? { ...saved, translucency: 0 } : saved;
  // Values saved past 100% (from when the slider ran higher) read as 100%.
  return { ...appearance, translucency: snapTranslucency(appearance.translucency) };
}
export function saveAppearance(storage: KeyValueStorage | undefined, value: Appearance): void {
  writeJson(storage, storageKey, value);
}

/** The operating system's preferences that appearance settings can defer to. */
export interface SystemPreferences {
  dark: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
  /** The browser draws without graphics acceleration (`renderer.ts`): blurs cost the CPU. */
  softwareRendering: boolean;
}

/** What the page actually shows once "system" and the OS's accessibility settings are applied. */
export interface ResolvedAppearance {
  theme: ThemeId;
  /** The Suit on screen, or null when the theme shows (`suits/applied-suit.ts`). */
  suit: SuitId | null;
  scheme: Scheme;
  /**
   * Solid at translucency 0, while the OS reduces transparency, and in a theme whose layers are
   * always solid (one without glass); translucent otherwise.
   */
  surface: SurfaceSetting;
  /** The translucency on screen: the setting, or 0 wherever the layers are solid. */
  translucency: number;
  reduceMotion: boolean;
}

/** Whether a theme's floating layers can be glass at all in `scheme`. */
export function themeHasGlass(theme: ThemeId, scheme: Scheme): boolean {
  return themes[theme][scheme].material.glass !== null;
}

/**
 * `suit` is the Suit that applies (`appliedSuit`), or null for the theme. A Suit with one scheme
 * runs only in that scheme, whatever the mode asks for.
 */
export function resolveAppearance(
  appearance: Appearance,
  system: SystemPreferences,
  suit: SuitDetail | null = null,
): ResolvedAppearance {
  const asked = appearance.mode === "system" ? (system.dark ? "dark" : "light") : appearance.mode;
  const scheme = suit ? suitSchemeFor(suit.manifest, asked) : asked;
  const translucency = snapTranslucency(appearance.translucency);
  const glass = suit
    ? suitPalette(suit.manifest, scheme).material.glass !== null
    : themeHasGlass(appearance.theme, scheme);
  const solid =
    translucency === 0 || system.reducedTransparency || system.softwareRendering || !glass;
  return {
    theme: appearance.theme,
    suit: suit?.summary.id ?? null,
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
  /**
   * The Suit applied last, whose rules `css` carries after the theme's; `index.html` sets
   * `data-suit` from it unless Suits are off this session. The app holds it until the daemon
   * has answered, so a reload keeps the look.
   */
  suit?: SuitDetail | undefined;
  mode: Mode;
  surface: SurfaceSetting;
  translucency: number;
  reduceMotion: ReduceMotion;
  density: Density;
  /** The Suit's one scheme, for a Suit that has only one; it stands in for `mode`. */
  suitScheme?: Scheme | undefined;
  /** The Suit's own density, over `density` while it is on. */
  suitDensity?: Density | undefined;
  transcriptPx: number;
  css: string;
}
export const bootAppearanceKey = "ace.boot-appearance";
