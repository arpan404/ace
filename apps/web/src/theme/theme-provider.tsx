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
import type { GlassEngine } from "./glass.ts";
import { startLiquidGlass } from "./liquid-glass.ts";
import { themes } from "./palettes.ts";
import { withViewTransition } from "@/lib/motion.ts";

export interface Environment {
  storage?: KeyValueStorage | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  root?: HTMLElement | undefined;
  /** Which glass this browser can render (`glassEngine`); blur when unknown. */
  glassEngine?: GlassEngine | undefined;
  /**
   * The desktop window's colour behind the page: the theme's page colour in each scheme and the
   * mode that picks between them, so its next launch (and every resize) starts in this theme.
   */
  windowBackground?: ((value: { mode: Mode; light: string; dark: string }) => void) | undefined;
}

interface ThemeValue {
  appearance: Appearance;
  update(next: Partial<Appearance>): void;
  /** What's on screen, with "system" and the OS's accessibility settings applied. */
  resolved: ResolvedAppearance;
  /** The OS asks for less transparency, so Translucent shows as solid. */
  systemReducesTransparency: boolean;
}
const ThemeContext = createContext<ThemeValue | undefined>(undefined);

const queries = {
  dark: "(prefers-color-scheme: dark)",
  reducedMotion: "(prefers-reduced-motion: reduce)",
  reducedTransparency: "(prefers-reduced-transparency: reduce)",
} as const;

/** The OS preferences, read before the first render; a light/dark change cross-fades. */
function useSystemPreferences(matchMedia: Environment["matchMedia"]): SystemPreferences {
  const read = useCallback(
    (): SystemPreferences => ({
      dark: matchMedia?.(queries.dark).matches ?? true,
      reducedMotion: matchMedia?.(queries.reducedMotion).matches ?? false,
      reducedTransparency: matchMedia?.(queries.reducedTransparency).matches ?? false,
    }),
    [matchMedia],
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
  const [appearance, setAppearance] = useState(() => loadAppearance(storage));
  const system = useSystemPreferences(matchMedia);
  const resolved = useMemo(() => resolveAppearance(appearance, system), [appearance, system]);
  const { accent, customAccent } = appearance;
  // Every theme with the chosen accent: one sheet, so a theme switch is an attribute flip.
  const stylesheet = useMemo(
    () => themesStylesheet({ accent, customAccent }),
    [accent, customAccent],
  );

  // Layout effect, so a theme switch inside a view transition lands before the new snapshot.
  useLayoutEffect(() => {
    if (!root) return;
    applyTheme(root, stylesheet, {
      "data-theme": resolved.theme,
      "data-scheme": resolved.scheme,
      "data-surface": resolved.surface,
      "data-reduce-motion": resolved.reduceMotion ? "" : undefined,
      "data-density": appearance.density,
      "data-glass-engine": glassEngine,
    });
    root.style.setProperty(
      "--transcript-size",
      `${transcriptSizes[appearance.transcriptSize].px}px`,
    );
    setThemeColour(root.ownerDocument, themes[resolved.theme][resolved.scheme].s0);
  }, [root, stylesheet, resolved, appearance.density, appearance.transcriptSize, glassEngine]);

  // Per-layer liquid glass filters, only while they can show.
  const liquid = glassEngine === "liquid" && resolved.surface === "translucent";
  useEffect(() => {
    if (!root || !liquid) return;
    return startLiquidGlass(root.ownerDocument);
  }, [root, liquid]);

  useEffect(() => {
    const boot: BootAppearance = {
      theme: appearance.theme,
      mode: appearance.mode,
      surface: appearance.surface,
      reduceMotion: appearance.reduceMotion,
      density: appearance.density,
      transcriptPx: transcriptSizes[appearance.transcriptSize].px,
      css: themeStylesheet(appearance.theme, appearance),
    };
    writeJson(storage, bootAppearanceKey, boot);
  }, [storage, appearance]);

  const { windowBackground } = props.environment;
  useEffect(() => {
    const palette = themes[appearance.theme];
    windowBackground?.({ mode: appearance.mode, light: palette.light.s0, dark: palette.dark.s0 });
  }, [windowBackground, appearance.theme, appearance.mode]);

  const update = useCallback(
    (next: Partial<Appearance>) => {
      const apply = () =>
        setAppearance((previous) => {
          const merged = { ...previous, ...next };
          saveAppearance(storage, merged);
          return merged;
        });
      // A new palette cross-fades the window; the other settings apply directly.
      if (next.theme !== undefined || next.mode !== undefined || next.accent !== undefined)
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
    }),
    [appearance, update, resolved, system.reducedTransparency],
  );
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

function applyTheme(
  root: HTMLElement,
  stylesheet: string,
  attributes: Record<string, string | undefined>,
) {
  const document = root.ownerDocument;
  let sheet = document.getElementById("ace-themes");
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "ace-themes";
    document.head.append(sheet);
  }
  if (sheet.textContent !== stylesheet) sheet.textContent = stylesheet;
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

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme needs a <ThemeProvider>");
  return value;
}
