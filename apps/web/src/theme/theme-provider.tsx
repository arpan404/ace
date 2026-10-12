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
  type ResolvedAppearance,
  type SystemPreferences,
} from "./appearance.ts";
import { allThemesStylesheet, themeStylesheet } from "./css.ts";
import { installLiquidGlass, type GlassEngine } from "./glass.ts";
import { themes } from "./palettes.ts";
import { withViewTransition } from "@/lib/motion.ts";

export interface Environment {
  storage?: KeyValueStorage | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  root?: HTMLElement | undefined;
  /** Which glass this browser can render (`glassEngine`); blur when unknown. */
  glassEngine?: GlassEngine | undefined;
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

  // Layout effect, so a theme switch inside a view transition lands before the new snapshot.
  useLayoutEffect(() => {
    if (!root) return;
    const engine =
      glassEngine === "liquid" && installLiquidGlass(root.ownerDocument) ? "liquid" : "blur";
    applyTheme(root, {
      "data-theme": resolved.theme,
      "data-scheme": resolved.scheme,
      "data-surface": resolved.surface,
      "data-reduce-motion": resolved.reduceMotion ? "" : undefined,
      "data-density": appearance.density,
      "data-glass-engine": engine,
    });
    root.style.setProperty(
      "--transcript-size",
      `${transcriptSizes[appearance.transcriptSize].px}px`,
    );
    setThemeColour(root.ownerDocument, themes[resolved.theme][resolved.scheme].s0);
  }, [root, resolved, appearance.density, appearance.transcriptSize, glassEngine]);

  useEffect(() => {
    const boot: BootAppearance = {
      theme: appearance.theme,
      mode: appearance.mode,
      surface: appearance.surface,
      reduceMotion: appearance.reduceMotion,
      density: appearance.density,
      transcriptPx: transcriptSizes[appearance.transcriptSize].px,
      css: themeStylesheet(appearance.theme),
    };
    writeJson(storage, bootAppearanceKey, boot);
  }, [storage, appearance]);

  const update = useCallback(
    (next: Partial<Appearance>) => {
      const apply = () =>
        setAppearance((previous) => {
          const merged = { ...previous, ...next };
          saveAppearance(storage, merged);
          return merged;
        });
      // A new palette cross-fades the window; the other settings apply directly.
      if (next.theme !== undefined || next.mode !== undefined)
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

function applyTheme(root: HTMLElement, attributes: Record<string, string | undefined>) {
  const document = root.ownerDocument;
  let sheet = document.getElementById("ace-themes");
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "ace-themes";
    document.head.append(sheet);
  }
  if (sheet.textContent !== allThemesStylesheet) sheet.textContent = allThemesStylesheet;
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
