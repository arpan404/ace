/**
 * ace Mobile Design Tokens
 * Native-first styling tailored for premium app feel.
 */

export const Typography = {
  fonts: {
    ui: "System",
    mono: "Menlo",
  },
  letterSpacing: {
    tight: -0.018,
  },
} as const;

export const Palette = {
  light: {
    background: "#f2f2f7", // iOS system gray 6
    foreground: "#000000",
    card: "#ffffff",
    cardForeground: "#000000",
    surface: "#f9f9f9",
    activeSurface: "#e8e8eb",
    popover: "#ffffff",
    popoverForeground: "#000000",
    primary: "#0066ff", // Native vibrant blue
    primaryForeground: "#ffffff",
    secondary: "#e5e5ea",
    secondaryForeground: "#000000",
    muted: "#e5e5ea",
    mutedForeground: "#8e8e93",
    accent: "#e5e5ea",
    accentForeground: "#000000",
    destructive: "#ff3b30",
    dangerSurface: "#ffe5e5",
    dangerForeground: "#990000",
    border: "rgba(0, 0, 0, 0.08)", // Subtle hair-line native border
    input: "#ffffff",
    ring: "#0066ff",
    info: "#8e8e93",
  },
  dark: {
    background: "#000000", // Pure OLED black
    foreground: "#ffffff",
    card: "#1c1c1e", // Native elevated dark gray
    cardForeground: "#ffffff",
    surface: "#0d0d0f",
    activeSurface: "#2a2a2e",
    popover: "#1c1c1e",
    popoverForeground: "#ffffff",
    primary: "#0a84ff", // Native vibrant blue dark
    primaryForeground: "#ffffff",
    secondary: "#2c2c2e",
    secondaryForeground: "#ffffff",
    muted: "#2c2c2e",
    mutedForeground: "#8e8e93",
    accent: "#2c2c2e",
    accentForeground: "#ffffff",
    destructive: "#ff453a",
    dangerSurface: "#5a2f2f",
    dangerForeground: "#ff9999",
    border: "rgba(255, 255, 255, 0.12)", // Subtle hair-line native border
    input: "#1c1c1e",
    ring: "#0a84ff",
    info: "#8e8e93",
  },
} as const;
