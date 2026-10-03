import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { writeJson, type KeyValueStorage } from "@ace/ui-core";
import {
  bootThemeKey,
  loadAppearance,
  saveAppearance,
  transcriptSizes,
  type Appearance,
  type BootTheme,
} from "./appearance.ts";
import { themeStylesheet } from "./css.ts";
import { loadCustomThemes, saveCustomThemes } from "./custom-themes.ts";
import { basePreset, presetThemes, type Theme } from "./presets.ts";

export interface Environment {
  storage?: KeyValueStorage | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  root?: HTMLElement | undefined;
}

interface ThemeValue {
  appearance: Appearance;
  update(next: Partial<Appearance>): void;
  /** The theme on screen, with "system" resolved. */
  theme: Theme;
  /** Presets followed by the user's custom themes. */
  themes: readonly Theme[];
  customThemes: readonly Theme[];
  /** Insert or replace a custom theme by id. */
  saveTheme(theme: Theme): void;
  deleteTheme(id: string): void;
}
const ThemeContext = createContext<ThemeValue | undefined>(undefined);
const darkQuery = "(prefers-color-scheme: dark)";

function useSystemDark(matchMedia: Environment["matchMedia"]): boolean {
  const [dark, setDark] = useState(() => matchMedia?.(darkQuery).matches ?? true);
  useEffect(() => {
    const query = matchMedia?.(darkQuery);
    if (!query) return;
    const changed = () => setDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [matchMedia]);
  return dark;
}

/**
 * Theme, accent, glass, density and transcript size, applied as attributes and variables on
 * <html>. Every theme's tokens are injected as one stylesheet, so switching is an attribute flip.
 */
export function ThemeProvider(props: { environment: Environment; children: ReactNode }) {
  const { storage, matchMedia, root } = props.environment;
  const [appearance, setAppearance] = useState(() => loadAppearance(storage));
  const [customThemes, setCustomThemes] = useState(() => loadCustomThemes(storage));
  const systemDark = useSystemDark(matchMedia);
  const themes = useMemo(() => [...presetThemes, ...customThemes], [customThemes]);

  const wanted = appearance.theme === "system" ? (systemDark ? "dark" : "light") : appearance.theme;
  const theme = themes.find((candidate) => candidate.id === wanted) ?? basePreset("dark");

  const css = useMemo(() => themeStylesheet(themes), [themes]);
  useEffect(() => {
    if (!root) return;
    const attributes: Record<string, string> = {
      "data-theme": theme.id,
      "data-scheme": theme.scheme,
      "data-accent": appearance.accent,
      "data-density": appearance.density,
    };
    const style: Record<string, string> = {
      "--accent-custom": appearance.customAccent,
      "--glass": String(appearance.glass),
      "--transcript-size": `${transcriptSizes[appearance.transcriptSize].px}px`,
    };
    applyTheme(root, css, attributes, style);
    const boot: BootTheme = {
      system: appearance.theme === "system",
      theme: theme.id,
      attributes,
      style,
      css,
    };
    writeJson(storage, bootThemeKey, boot);
  }, [root, storage, css, theme.id, theme.scheme, appearance]);

  const update = useCallback(
    (next: Partial<Appearance>) =>
      setAppearance((previous) => {
        const merged = { ...previous, ...next };
        saveAppearance(storage, merged);
        return merged;
      }),
    [storage],
  );
  const saveTheme = useCallback(
    (next: Theme) =>
      setCustomThemes((previous) => {
        const index = previous.findIndex((candidate) => candidate.id === next.id);
        const list =
          index === -1 ? [...previous, next] : previous.map((t, i) => (i === index ? next : t));
        saveCustomThemes(storage, list);
        return list;
      }),
    [storage],
  );
  const deleteTheme = useCallback(
    (id: string) =>
      setCustomThemes((previous) => {
        const list = previous.filter((candidate) => candidate.id !== id);
        saveCustomThemes(storage, list);
        return list;
      }),
    [storage],
  );
  const value = useMemo(
    () => ({ appearance, update, theme, themes, customThemes, saveTheme, deleteTheme }),
    [appearance, update, theme, themes, customThemes, saveTheme, deleteTheme],
  );
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

function applyTheme(
  root: HTMLElement,
  css: string,
  attributes: Record<string, string>,
  style: Record<string, string>,
) {
  const document = root.ownerDocument;
  let sheet = document.getElementById("ace-themes");
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "ace-themes";
    document.head.append(sheet);
  }
  if (sheet.textContent !== css) sheet.textContent = css;
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
  for (const [name, value] of Object.entries(style)) root.style.setProperty(name, value);
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme needs a <ThemeProvider>");
  return value;
}
