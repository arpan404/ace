/**
 * ace Mobile Design Tokens
 * iOS-native semantic palette following Apple Human Interface Guidelines.
 */

export const Typography = {
  fonts: {
    ui: "System",
    mono: "Menlo",
  },
} as const;

export const Palette = {
  light: {
    background: "#f2f2f7",
    foreground: "#000000",
    secondaryLabel: "#3c3c43",
    tertiaryLabel: "#48484a",
    separator: "#c6c6c8",
    groupedBackground: "#f2f2f7",
    secondaryGroupedBackground: "#ffffff",
    primary: "#007aff",
    primaryForeground: "#ffffff",
    tint: "#007aff",
    green: "#34c759",
    orange: "#ff9500",
    red: "#ff3b30",
    yellow: "#ffcc00",
    muted: "#8e8e93",
    fill: "rgba(120, 120, 128, 0.2)",
    secondaryFill: "rgba(120, 120, 128, 0.16)",
    tertiaryFill: "rgba(118, 118, 128, 0.12)",
  },
  dark: {
    background: "#000000",
    foreground: "#ffffff",
    secondaryLabel: "#ebebf5",
    tertiaryLabel: "#ebebf5",
    separator: "#38383a",
    groupedBackground: "#000000",
    secondaryGroupedBackground: "#1c1c1e",
    primary: "#0a84ff",
    primaryForeground: "#ffffff",
    tint: "#0a84ff",
    green: "#30d158",
    orange: "#ff9f0a",
    red: "#ff453a",
    yellow: "#ffd60a",
    muted: "#8e8e93",
    fill: "rgba(120, 120, 128, 0.36)",
    secondaryFill: "rgba(120, 120, 128, 0.32)",
    tertiaryFill: "rgba(118, 118, 128, 0.24)",
  },
} as const;
