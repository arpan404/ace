import { onDeviceSetting } from "@/lib/device-setting.ts";
import { railMeasureKey } from "@/lib/rail-measure.ts";
import { railPinsKey } from "@/lib/rail-pins.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { readJson, writeJson, RailMeasure, RailPins, type KeyValueStorage } from "@ace/ui-core";
import {
  bootAppearanceKey,
  changesAppearance,
  loadAppearance,
  resolveAppearance,
  saveAppearance,
  transcriptSizes,
  type Appearance,
  type BootAppearance,
  type ResolvedAppearance,
  type SystemPreferences,
} from "./appearance.ts";
import { themesStylesheet, themeStylesheet } from "./css.ts";
import type { SuitDetail, SuitId } from "@ace/protocol/suits";
import { suitDensity, suitPalette, suitSchemes, suitSheets } from "./suits/suit-css.ts";
import { browserFontLoader, useSuitFontsReady } from "./suits/suit-fonts.ts";
import { useAppliedSuit, type SuitReport } from "./suits/use-applied-suit.ts";
import { suitLayoutStylesheet } from "./suits/suit-layout.ts";
import type { GlassEngine } from "./glass.ts";
import { startLiquidGlass } from "./liquid-glass.ts";
import { themedPalette, themes } from "@ace/themes";
import { glassAmount, glassVariables } from "./translucency.ts";
import { withViewTransition } from "@/lib/motion.ts";

/** The longest a cross-fade to a Suit waits for it to show before it fades anyway. */
const suitSwapWaitMs = 500;

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
  windowBackground?: ((value: ReturnType<typeof windowColours>) => void) | undefined;
  /** `?suit=off` this session (`suitsOffForSession`): the chosen theme shows, never a Suit. */
  suitsOff?: boolean | undefined;
  /**
   * Another window of the app changed `storage` (the browser's `storage` event): the key it
   * changed, null when it cleared everything. The look follows, so every window (the desktop's
   * menu-bar popover, a second tab) shows the theme, Suit and accent chosen in any of them.
   */
  onStorage?: ((listener: (key: string | null) => void) => () => void) | undefined;
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
  const { applied, trying, reportSuits, recache } = useAppliedSuit(
    storage,
    appearance.suit,
    suitsOff,
  );
  // Another window changed the look: its choice, and the Suit it applied (recorded in the boot
  // cache), show here too, before this window's own read of the Suit lands.
  const { onStorage } = props.environment;
  useEffect(
    () =>
      onStorage?.((key) => {
        if (changesAppearance(key)) setAppearance(loadAppearance(storage));
        if (key === null || key === bootAppearanceKey) recache();
      }),
    [onStorage, storage, recache],
  );
  // A Suit shows once its bundled fonts have loaded, so a switch never flashes a fallback face.
  const [fontLoader] = useState(() => browserFontLoader(root?.ownerDocument));
  const suit = useSuitFontsReady(applied, fontLoader);
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

  // A Suit being switched on is read and its fonts loaded after the switch: the cross-fade's new
  // picture waits until it shows (`update`), here, once its sheet and tokens are on the page.
  const shownSuit = useRef<SuitId | null>(null);
  const suitSwap = useRef<{ id: SuitId; done: () => void } | undefined>(undefined);
  useLayoutEffect(() => {
    shownSuit.current = suit?.summary.id ?? null;
    const waiting = suitSwap.current;
    if (waiting && waiting.id === shownSuit.current) {
      suitSwap.current = undefined;
      waiting.done();
    }
  }, [suit]);

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

  // A Suit only being tried on never becomes the look the next launch boots in.
  useEffect(() => {
    if (trying) return;
    writeJson(storage, bootAppearanceKey, bootAppearance(appearance, suit, softwareRendering));
  }, [storage, appearance, suit, softwareRendering, trying]);

  const { windowBackground } = props.environment;
  useEffect(() => {
    if (!windowBackground) return;
    const sync = () => windowBackground(windowColours(appearance, suit, storage));
    sync();
    const unwatchPins = onDeviceSetting(storage, railPinsKey, sync);
    const unwatchMeasure = onDeviceSetting(storage, railMeasureKey, sync);
    const unwatchOtherWindows = onStorage?.((key) => {
      if (key === null || key === railMeasureKey || key === railPinsKey) sync();
    });
    return () => {
      unwatchPins();
      unwatchMeasure();
      unwatchOtherWindows?.();
    };
  }, [windowBackground, appearance, suit, storage, onStorage]);

  const update = useCallback(
    (next: Partial<Appearance>) => {
      const apply = () =>
        setAppearance((previous) => {
          const merged = { ...previous, ...next };
          saveAppearance(storage, merged);
          return merged;
        });
      // A new palette cross-fades the window; the other settings apply directly. A Suit switching
      // on lands a moment later (its read and fonts): the fade waits for it, briefly at most.
      const wanted = next.suit;
      if (wanted && wanted !== shownSuit.current)
        withViewTransition(
          () =>
            new Promise<void>((resolve) => {
              suitSwap.current = { id: wanted, done: resolve };
              flushSync(apply);
              window.setTimeout(resolve, suitSwapWaitMs);
            }),
        );
      else if (
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
function windowColours(appearance: Appearance, suit: SuitDetail | null, storage?: KeyValueStorage) {
  const light = suit ? suitPalette(suit.manifest, "light") : themes[appearance.theme].light;
  const dark = suit ? suitPalette(suit.manifest, "dark") : themes[appearance.theme].dark;
  const only = suit ? suitSchemes(suit.manifest) : [];
  const uiFont = suit?.manifest.fonts?.ui;
  const tray = (palette: typeof light, scheme: "light" | "dark") => ({
    surface: palette.s2,
    text: palette.t1,
    muted: palette.t2,
    accent:
      appearance.accent === "theme" || suit
        ? palette.accent
        : themedPalette(appearance.theme, scheme, appearance).accent,
    needs: palette.needsText,
    opacity: palette.material.glass
      ? 1 - glassAmount(appearance.translucency) * (1 - palette.glassTint)
      : 1,
  });
  return {
    mode: only.length === 1 && only[0] ? only[0] : appearance.mode,
    light: light.s0,
    dark: dark.s0,
    tray: {
      light: tray(light, "light"),
      dark: tray(dark, "dark"),
      radius: suit?.manifest.shape?.radius,
      border: suit?.manifest.shape?.border,
      font: uiFont && "system" in uiFont ? uiFont.system : undefined,
      compact:
        (suit ? (suitDensity(suit.manifest) ?? appearance.density) : appearance.density) ===
        "compact",
    },
    trayUsage: {
      measure: readJson(storage, railMeasureKey, RailMeasure, "week"),
      pins: readJson(storage, railPinsKey, RailPins, []),
    },
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

/** The surfaces a mark is drawn on in each scheme: the page, raised fills and the side panel. */
export type CanvasColours = Record<"light" | "dark", readonly string[]>;

/**
 * The page, raised and side-panel colours of each scheme of the theme or Suit on screen, so a
 * mark (a bot's accent) can be checked against what it is really drawn on. Null outside a
 * `ThemeProvider`.
 */
export function useCanvasColours(): CanvasColours | null {
  const value = useContext(ThemeContext);
  const theme = value?.appearance.theme;
  const suit = value?.suit ?? null;
  return useMemo(() => {
    if (!theme) return null;
    const of = (scheme: "light" | "dark") => {
      const palette = suit ? suitPalette(suit.manifest, scheme) : themes[theme][scheme];
      return [palette.s0, palette.s1, palette.sidebar];
    };
    return { light: of("light"), dark: of("dark") };
  }, [theme, suit]);
}
