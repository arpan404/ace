export const FontFamilies = {
  uiRegular: "IBMPlexSans_400Regular",
  uiMedium: "IBMPlexSans_500Medium",
  uiSemiBold: "IBMPlexSans_600SemiBold",
  monoRegular: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
  fallbackSans: "System",
  fallbackMono: "Menlo",
} as const;

export const Typography = {
  fonts: FontFamilies,
  roles: {
    displayLg: {
      fontFamily: FontFamilies.uiSemiBold,
      fontSize: 30,
      lineHeight: 34,
      letterSpacing: -0.8,
    },
    titleLg: {
      fontFamily: FontFamilies.uiSemiBold,
      fontSize: 24,
      lineHeight: 28,
      letterSpacing: -0.55,
    },
    titleMd: {
      fontFamily: FontFamilies.uiSemiBold,
      fontSize: 20,
      lineHeight: 24,
      letterSpacing: -0.35,
    },
    body: {
      fontFamily: FontFamilies.uiRegular,
      fontSize: 15,
      lineHeight: 21,
      letterSpacing: -0.08,
    },
    bodyStrong: {
      fontFamily: FontFamilies.uiMedium,
      fontSize: 15,
      lineHeight: 21,
      letterSpacing: -0.08,
    },
    meta: {
      fontFamily: FontFamilies.uiRegular,
      fontSize: 13,
      lineHeight: 18,
      letterSpacing: -0.04,
    },
    micro: {
      fontFamily: FontFamilies.uiMedium,
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 0.18,
    },
    monoMeta: {
      fontFamily: FontFamilies.monoRegular,
      fontSize: 12,
      lineHeight: 16,
    },
    monoCode: {
      fontFamily: FontFamilies.monoRegular,
      fontSize: 12,
      lineHeight: 18,
    },
  },
} as const;

const lightBase = {
  bg: {
    app: "#F6F3EE",
    canvas: "#FBF8F4",
    surface: "#FFFDFC",
    surfaceMuted: "#F3EFE9",
    surfaceStrong: "#ECE7DF",
    overlay: "rgba(23, 22, 20, 0.04)",
  },
  surfaces: {
    default: "#FFFDFC",
    muted: "#F3EFE9",
    strong: "#ECE7DF",
  },
  text: {
    primary: "#171614",
    secondary: "#5F5A53",
    tertiary: "#8A847C",
    inverse: "#FFFDFC",
  },
  border: {
    soft: "rgba(23, 22, 20, 0.08)",
    strong: "rgba(23, 22, 20, 0.14)",
    separator: "rgba(23, 22, 20, 0.08)",
  },
  accent: {
    primary: "#6D8A63",
    soft: "rgba(109, 138, 99, 0.12)",
    strong: "#55714D",
  },
  status: {
    success: "#5B7F52",
    warning: "#B07A2A",
    danger: "#B05245",
    info: "#5C7A91",
    muted: "#8A847C",
  },
  shadow: "#171614",
} as const;

const darkBase = {
  bg: {
    app: "#141311",
    canvas: "#1A1816",
    surface: "#201E1B",
    surfaceMuted: "#2A2723",
    surfaceStrong: "#34302B",
    overlay: "rgba(245, 241, 235, 0.03)",
  },
  surfaces: {
    default: "#201E1B",
    muted: "#2A2723",
    strong: "#34302B",
  },
  text: {
    primary: "#F5F1EB",
    secondary: "#C3BCB3",
    tertiary: "#938B82",
    inverse: "#141311",
  },
  border: {
    soft: "rgba(245, 241, 235, 0.08)",
    strong: "rgba(245, 241, 235, 0.14)",
    separator: "rgba(245, 241, 235, 0.08)",
  },
  accent: {
    primary: "#8EAB84",
    soft: "rgba(142, 171, 132, 0.16)",
    strong: "#A7C59A",
  },
  status: {
    success: "#90B384",
    warning: "#D0A258",
    danger: "#D17B6F",
    info: "#87A8C0",
    muted: "#938B82",
  },
  shadow: "#000000",
} as const;

function createCompatTheme<T extends typeof lightBase | typeof darkBase>(palette: T) {
  return {
    ...palette,
    background: palette.bg.app,
    backgroundColor: palette.bg.app,
    foreground: palette.text.primary,
    secondaryLabel: palette.text.secondary,
    tertiaryLabel: palette.text.tertiary,
    separator: palette.border.separator,
    groupedBackground: palette.bg.app,
    secondaryGroupedBackground: palette.bg.canvas,
    primary: palette.accent.primary,
    primaryForeground: palette.text.inverse,
    tint: palette.accent.primary,
    green: palette.status.success,
    orange: palette.status.warning,
    red: palette.status.danger,
    yellow: palette.status.warning,
    muted: palette.status.muted,
    fill: palette.bg.overlay,
    secondaryFill: palette.accent.soft,
    tertiaryFill: palette.bg.surfaceMuted,
    surface: palette.surfaces.default,
    surfaceSecondary: palette.surfaces.muted,
    surfaceTertiary: palette.surfaces.strong,
    card: palette.surfaces.default,
    overlay: palette.bg.overlay,
    elevatedBorder: palette.border.strong,
    accentSoft: palette.accent.soft,
    shadow: palette.shadow,
    backgroundLegacy: palette.bg.app,
  } as const;
}

export const Palette = {
  light: createCompatTheme(lightBase),
  dark: createCompatTheme(darkBase),
} as const;
