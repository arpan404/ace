import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { Palette } from "./tokens";
import { formatErrorMessage } from "../errors";

const THEME_MODE_STORAGE_KEY = "ace-mobile-theme-mode";
export type ThemeMode = "system" | "light" | "dark";

function isThemeMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

type ThemeColors = {
  [K in keyof (typeof Palette)["light"]]: string;
};

interface ThemeContextValue {
  theme: ThemeColors;
  isDark: boolean;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");

  const isDark = themeMode === "system" ? systemColorScheme === "dark" : themeMode === "dark";
  const theme = useMemo(() => (isDark ? Palette.dark : Palette.light), [isDark]);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(THEME_MODE_STORAGE_KEY)
      .then((storedThemeMode) => {
        if (!mounted || !storedThemeMode || !isThemeMode(storedThemeMode)) {
          return;
        }
        setThemeModeState(storedThemeMode);
      })
      .catch((error: unknown) => {
        console.error(`Couldn't load theme mode: ${formatErrorMessage(error)}`);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const setThemeMode = useCallback((nextThemeMode: ThemeMode) => {
    setThemeModeState(nextThemeMode);
    void AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, nextThemeMode).catch((error: unknown) => {
      console.error(`Couldn't save theme mode: ${formatErrorMessage(error)}`);
    });
  }, []);

  const value = useMemo(
    () => ({
      theme,
      isDark,
      themeMode,
      setThemeMode,
    }),
    [theme, isDark, themeMode, setThemeMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
