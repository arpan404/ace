import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { writeJson, type KeyValueStorage } from "@ace/ui-core";
import {
  bootAppearanceKey,
  loadAppearance,
  resolveAppearance,
  saveAppearance,
  transcriptSizes,
  type Appearance,
  type BootAppearance,
  type Mode,
  type ResolvedAppearance,
  type SystemPreferences,
} from "./appearance.ts";
import { themesStylesheet, themeStylesheet } from "./css.ts";
import type { SuitDetail } from "@ace/protocol/suits";
import { suitDensity, suitPalette, suitSchemes, suitSheets } from "./suits/suit-css.ts";
import { useAppliedSuit, type SuitReport } from "./suits/use-applied-suit.ts";
import { suitLayoutStylesheet } from "./suits/suit-layout.ts";
import type { GlassEngine } from "./glass.ts";
import { startLiquidGlass } from "./liquid-glass.ts";
import { themes } from "@ace/themes";
import { glassVariables } from "./translucency.ts";
import { withViewTransition } from "@/lib/motion.ts";

export interface Environment {
  storage?: KeyValueStorage | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  root?: HTMLElement | undefined;
  /** The browser draws without graphics acceleration (`softwareRendering`): Solid surfaces. */
  softwareRendering?: boolean | undefined;
  /** Which glass this browser can render (`glassEngine`); blur when unknown. */
  glassEngine?: GlassEngine | undefined;
  /**
   * The desktop window's colour behind the page: the theme's page colour in each scheme and the
   * mode that picks between them, so its next launch (and every resize) starts in this theme.
   */
  windowBackground?: ((value: { mode: Mode; light: string; dark: string }) => void) | undefined;
  /** `?suit=off` this session (`suitsOffForSession`): the chosen theme shows, never a Suit. */
  suitsOff?: boolean | undefined;
}

interface ThemeValue {
  appearance: Appearance;
  update(next: Partial<Appearance>): void;
  /** What's on screen, with "system" and the OS's accessibility settings applied. */
  resolved: ResolvedAppearance;
  /** The OS asks for less transparency, so Translucency shows as Solid. */
  systemReducesTransparency: boolean;
  /** This device draws without graphics acceleration, so Translucency shows as Solid. */
  softwareRendering: boolean;
  /** The Suit on screen, or null when the theme shows. */
  suit: SuitDetail | null;
  /** Suits are off this session (`?suit=off`). */
  suitsOff: boolean;
  /** What the Suit library knows (`SuitLibraryProvider`), so the picked Suit can apply. */
  reportSuits(report: SuitReport): void;
}
const ThemeContext = createContext<ThemeValue | undefined>(undefined);

const queries = {
  dark: "(prefers-color-scheme: dark)",
  reducedMotion: "(prefers-reduced-motion: reduce)",
  reducedTransparency: "(prefers-reduced-transparency: reduce)",
} as const;

/** The OS preferences, read before the first render; a light/dark change cross-fades. */
function useSystemPreferences(
  matchMedia: Environment["matchMedia"],
  softwareRendering: boolean,
): SystemPreferences {
  const read = useCallback(
    (): SystemPreferences => ({
      dark: matchMedia?.(queries.dark).matches ?? true,
      reducedMotion: matchMedia?.(queries.reducedMotion).matches ?? false,
      reducedTransparency: matchMedia?.(queries.reducedTransparency).matches ?? false,
      softwareRendering,
    }),
    [matchMedia, softwareRendering],
  );
  const [system, setSystem] = useState(read);
  useEffect(() => {
    if (!matchMedia) return;
    const lists = Object.values(queries).map((query) => matchMedia(query));
    let dark = read().dark;
    const changed = () => {
      const next = read();
      const flipped = next.dark !== dark;
      dark = next.dark;
      if (flipped) withViewTransition(() => flushSync(() => setSystem(next)));
      else setSystem(next);
    };
    for (const list of lists) list.addEventListener?.("change", changed);
    return () => {
      for (const list of lists) list.removeEventListener?.("change", changed);
    };
  }, [matchMedia, read]);
  return system;
}

/**
 * Mode, theme, surfaces, reduced motion, density and transcript size, applied as attributes and
 * one variable on <html>. Every theme is injected as one stylesheet, so switching is an
 * attribute flip; `index.html` replays the boot record so the first frame is already right.
 */
export function ThemeProvider(props: { environment: Environment; children: ReactNode }) {
  const { storage, matchMedia, root, glassEngine = "blur" } = props.environment;
  const softwareRendering = props.environment.softwareRendering ?? false;
  const [appearance, setAppearance] = useState(() => loadAppearance(storage));
  const system = useSystemPreferences(matchMedia, softwareRendering);
  const suitsOff = props.environment.suitsOff ?? false;
  const { applied: suit, reportSuits } = useAppliedSuit(storage, appearance.suit, suitsOff);
  const resolved = useMemo(
    () => resolveAppearance(appearance, system, suit),
    [appearance, system, suit],
  );
  // A Suit's own density, when it sets one, over the device's.
  const density = (suit && suitDensity(suit.manifest)) ?? appearance.density;
  const { accent, customAccent } = appearance;
  // Every theme with the chosen accent: one sheet, so a theme switch is an attribute flip.
  const stylesheet = useMemo(
    () => themesStylesheet({ accent, customAccent }),
    [accent, customAccent],
  );

  // The Suit's rules, after the themes' so they win where both match; its suit.css in
  // `@layer suit` under ace's guard, then its reading-column width. A new version of the Suit
  // swaps this text, never a reload.
  const suitSheet = useMemo(
    () =>
      suit
        ? [suitSheets(suit), suitLayoutStylesheet(suit.manifest)].filter(Boolean).join("\n")
        : "",
    [suit],
  );

  // Layout effect, so a theme switch inside a view transition lands before the new snapshot.
  useLayoutEffect(() => {
    if (!root) return;
    applyTheme(root, stylesheet, suitSheet, {
      "data-theme": resolved.theme,
      "data-suit": resolved.suit ?? undefined,
      "data-scheme": resolved.scheme,
      "data-surface": resolved.surface,
      "data-reduce-motion": resolved.reduceMotion ? "" : undefined,
      "data-density": density,
      "data-glass-engine": glassEngine,
    });
    root.style.setProperty(
      "--transcript-size",
      `${transcriptSizes[appearance.transcriptSize].px}px`,
    );
    const page = suit
      ? suitPalette(suit.manifest, resolved.scheme)
      : themes[resolved.theme][resolved.scheme];
    setThemeColour(root.ownerDocument, page.s0);
  }, [
    root,
    stylesheet,
    suitSheet,
    suit,
    resolved,
    density,
    appearance.transcriptSize,
    glassEngine,
  ]);

  // The glass at the chosen translucency, over the stylesheet's default. A slider drag changes
  // only the glass variables: no stylesheet rebuild, and the liquid filters below stay put.
  const { theme, scheme, translucency } = resolved;
  useLayoutEffect(() => {
    if (!root) return;
    const palette = suit ? suitPalette(suit.manifest, scheme) : themes[theme][scheme];
    const variables = glassVariables(palette, scheme, translucency);
    for (const [name, value] of Object.entries(variables))
      if (translucency > 0) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
  }, [root, suit, theme, scheme, translucency]);

  // Per-layer liquid glass filters, only while they can show.
  const liquid = glassEngine === "liquid" && resolved.surface === "translucent";
  useEffect(() => {
    if (!root || !liquid) return;
    return startLiquidGlass(root.ownerDocument);
  }, [root, liquid]);

  useEffect(() => {
    writeJson(storage, bootAppearanceKey, bootAppearance(appearance, suit, softwareRendering));
  }, [storage, appearance, suit, softwareRendering]);

  const { windowBackground } = props.environment;
  useEffect(() => {
    windowBackground?.(windowColours(appearance, suit));
  }, [windowBackground, appearance, suit]);

  const update = useCallback(
    (next: Partial<Appearance>) => {
      const apply = () =>
        setAppearance((previous) => {
          const merged = { ...previous, ...next };
          saveAppearance(storage, merged);
          return merged;
        });
      // A new palette cross-fades the window; the other settings apply directly.
      if (
        next.theme !== undefined ||
        next.mode !== undefined ||
        next.accent !== undefined ||
        next.suit !== undefined
      )
        withViewTransition(() => flushSync(apply));
      else apply();
    },
    [storage],
  );
  const value = useMemo(
    () => ({
      appearance,
      update,
      resolved,
      systemReducesTransparency: system.reducedTransparency,
      softwareRendering: system.softwareRendering,
      suit,
      suitsOff,
      reportSuits,
    }),
    [
      appearance,
      update,
      resolved,
      system.reducedTransparency,
      system.softwareRendering,
      suit,
      suitsOff,
      reportSuits,
    ],
  );
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

/**
 * What `index.html` replays before first paint. A Suit's rules follow the theme's, with its one
 * scheme and density beside them, used only while the Suit is on (not under `?suit=off`).
 */
function bootAppearance(
  appearance: Appearance,
  suit: SuitDetail | null,
  softwareRendering: boolean,
): BootAppearance {
  const only = suit ? suitSchemes(suit.manifest) : [];
  const glass = suit
    ? suitPalette(suit.manifest, only[0] ?? "dark").material.glass
    : themes[appearance.theme].light.material.glass;
  const themeCss = themeStylesheet(appearance.theme, appearance, appearance.translucency);
  return {
    theme: appearance.theme,
    suit: suit ?? undefined,
    mode: appearance.mode,
    suitScheme: only.length === 1 ? only[0] : undefined,
    // A theme with no glass boots solid, so its first frame never flashes translucent.
    surface: glass && appearance.translucency > 0 && !softwareRendering ? "translucent" : "solid",
    translucency: appearance.translucency,
    reduceMotion: appearance.reduceMotion,
    density: appearance.density,
    suitDensity: suit ? suitDensity(suit.manifest) : undefined,
    transcriptPx: transcriptSizes[appearance.transcriptSize].px,
    css: suit ? `${themeCss}\n${suitSheets(suit, appearance.translucency)}` : themeCss,
  };
}

/** The desktop window's colour behind the page, per scheme, in the theme or Suit on screen. */
function windowColours(appearance: Appearance, suit: SuitDetail | null) {
  if (!suit) {
    const palette = themes[appearance.theme];
    return { mode: appearance.mode, light: palette.light.s0, dark: palette.dark.s0 };
  }
  const only = suitSchemes(suit.manifest);
  return {
    mode: only.length === 1 && only[0] ? only[0] : appearance.mode,
    light: suitPalette(suit.manifest, "light").s0,
    dark: suitPalette(suit.manifest, "dark").s0,
  };
}

function styleElement(document: Document, id: string): HTMLElement {
  let sheet = document.getElementById(id);
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = id;
    document.head.append(sheet);
  }
  return sheet;
}

function applyTheme(
  root: HTMLElement,
  stylesheet: string,
  suitSheet: string,
  attributes: Record<string, string | undefined>,
) {
  const document = root.ownerDocument;
  const sheet = styleElement(document, "ace-themes");
  if (sheet.textContent !== stylesheet) sheet.textContent = stylesheet;
  // Appended after the themes' sheet, so a Suit's rules win at equal specificity.
  const suitElement = styleElement(document, "ace-suit");
  if (suitElement.textContent !== suitSheet) suitElement.textContent = suitSheet;
  for (const [name, value] of Object.entries(attributes))
    if (value === undefined) root.removeAttribute(name);
    else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

/** The browser's own bar (mobile Safari, Chrome on Android, installed apps) matches the page. */
function setThemeColour(document: Document, colour: string) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  if (meta.content !== colour) meta.content = colour;
}

/**
 * The Suit on screen, or null; null too outside a `ThemeProvider`, so a part a Suit can dress
 * (an empty state, the composer) still renders on its own.
 */
export function useSuitOnScreen(): SuitDetail | null {
  return useContext(ThemeContext)?.suit ?? null;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme needs a <ThemeProvider>");
  return value;
}
