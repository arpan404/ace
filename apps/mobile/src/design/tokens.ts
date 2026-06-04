export const FontFamilies = {
  uiRegular: "IBMPlexSans_400Regular",
  uiMedium: "IBMPlexSans_500Medium",
  uiSemiBold: "IBMPlexSans_600SemiBold",
  monoRegular: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
  fallbackSans: "System",
  fallbackMono: "System",
} as const;

export const Typography = {
  fonts: FontFamilies,
  roles: {
    displayLg: {
      fontSize: 32,
      lineHeight: 36,
      letterSpacing: -1.2,
      fontWeight: "800",
      textTransform: "uppercase",
    },
    titleLg: {
      fontSize: 24,
      lineHeight: 28,
      letterSpacing: -0.8,
      fontWeight: "800",
      textTransform: "uppercase",
    },
    titleMd: {
      fontSize: 18,
      lineHeight: 22,
      letterSpacing: -0.5,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    body: {
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0,
      fontWeight: "400",
    },
    bodyStrong: {
      fontSize: 14,
      lineHeight: 20,
      letterSpacing: 0,
      fontWeight: "600",
    },
    meta: {
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0,
      fontWeight: "500",
      textTransform: "uppercase",
    },
    micro: {
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 0.32,
      fontWeight: "600",
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
    app: "#F2F2EB", // warm paper
    canvas: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceMuted: "#EAEAE2",
    surfaceStrong: "#DCDCD2",
    overlay: "rgba(0, 0, 0, 0.08)",
  },
  surfaces: {
    default: "#FFFFFF",
    muted: "#EAEAE2",
    strong: "#DCDCD2",
  },
  text: {
    primary: "#1A1A1A",
    secondary: "#5C5C54",
    tertiary: "#8A8A80",
    inverse: "#F2F2EB",
  },
  border: {
    soft: "#DCDCD2",
    strong: "#1A1A1A",
    separator: "#DCDCD2",
  },
  accent: {
    primary: "#FF4500", // vibrant orange-red
    soft: "rgba(255, 69, 0, 0.12)",
    strong: "#D93A00",
  },
  status: {
    success: "#00A86B",
    warning: "#FFB300",
    danger: "#FF4500",
    info: "#0055FF",
    muted: "#8A8A80",
  },
  shadow: "rgba(26, 26, 26, 0.12)",
} as const;

const darkBase = {
  bg: {
    app: "#0D0D0D", // deep black
    canvas: "#141414",
    surface: "#141414",
    surfaceMuted: "#1F1F1F",
    surfaceStrong: "#2E2E2E",
    overlay: "rgba(255, 255, 255, 0.08)",
  },
  surfaces: {
    default: "#141414",
    muted: "#1F1F1F",
    strong: "#2E2E2E",
  },
  text: {
    primary: "#F2F2EB",
    secondary: "#A3A39A",
    tertiary: "#75756E",
    inverse: "#0D0D0D",
  },
  border: {
    soft: "#2E2E2E",
    strong: "#F2F2EB",
    separator: "#2E2E2E",
  },
  accent: {
    primary: "#FF4500",
    soft: "rgba(255, 69, 0, 0.15)",
    strong: "#FF6633",
  },
  status: {
    success: "#00D186",
    warning: "#FFCC33",
    danger: "#FF6633",
    info: "#3377FF",
    muted: "#75756E",
  },
  shadow: "rgba(0, 0, 0, 0.8)",
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
