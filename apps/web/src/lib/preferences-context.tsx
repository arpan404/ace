import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  loadPreferences,
  savePreferences,
  type KeyValueStorage,
  type Preferences,
} from "./preferences.ts";

interface PreferencesValue {
  preferences: Preferences;
  /** The theme actually shown, with "system" resolved. */
  resolvedTheme: "light" | "dark";
  update(next: Partial<Preferences>): void;
}
const PreferencesContext = createContext<PreferencesValue | undefined>(undefined);
const darkQuery = "(prefers-color-scheme: dark)";

export interface Environment {
  storage?: KeyValueStorage | undefined;
  matchMedia?: ((query: string) => MediaQueryList) | undefined;
  root?: HTMLElement | undefined;
}

/** Theme (light, dark, system) and density, applied as a class and data attribute on <html>. */
export function PreferencesProvider(props: { environment: Environment; children: ReactNode }) {
  const { storage, matchMedia, root } = props.environment;
  const [preferences, setPreferences] = useState(() => loadPreferences(storage));
  const [systemDark, setSystemDark] = useState(() => !!matchMedia?.(darkQuery).matches);
  useEffect(() => {
    const query = matchMedia?.(darkQuery);
    if (!query) return;
    const changed = () => setSystemDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [matchMedia]);
  const resolvedTheme =
    preferences.theme === "system" ? (systemDark ? "dark" : "light") : preferences.theme;
  useEffect(() => {
    root?.classList.toggle("dark", resolvedTheme === "dark");
    root?.setAttribute("data-density", preferences.density);
  }, [root, resolvedTheme, preferences.density]);
  const update = useCallback(
    (next: Partial<Preferences>) =>
      setPreferences((previous) => {
        const merged = { ...previous, ...next };
        savePreferences(storage, merged);
        return merged;
      }),
    [storage],
  );
  const value = useMemo(
    () => ({ preferences, resolvedTheme, update }),
    [preferences, resolvedTheme, update],
  );
  return <PreferencesContext.Provider value={value}>{props.children}</PreferencesContext.Provider>;
}
export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences needs a <PreferencesProvider>");
  return value;
}
